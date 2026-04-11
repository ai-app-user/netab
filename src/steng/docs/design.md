# steng Detailed Design

## Purpose

`steng` is the storage-focused subproject in this repository. It owns local storage semantics and deliberately stops before network policy.

Responsibilities:

- table catalog management
- canonical JSON and blob storage
- derived secondary indexes
- append-only per-table oplog
- subscription fanout
- local retention and watermarks
- deterministic remote op apply
- logical snapshot export/import

Non-goals:

- leader election
- replica scheduling
- auth / RBAC
- cluster routing
- cross-cluster failover policy

Those live in `cord` and `netab`.

## Public API Shape

The stable surface is defined in [types.ts](../types.ts) and [steng.ts](../steng.ts).

Application code is expected to use:

```ts
const steng = new Steng({ backend: "sqlite", sqlite: { filename: "./steng.sqlite" } });
```

Low-level implementations:

- [steng_engine.ts](../engine/steng_engine.ts): in-memory reference engine
- [sql_steng_engine.ts](../engine/sql_steng_engine.ts): shared SQL engine used by SQLite and Postgres

Main operation groups:

- schema: `ensure_table`, `get_table_info`, `list_tables`, `drop_table`
- config/indexes: `add_index`, `list_indexes`, `set_table_config`
- reads: `get_objs`, `subscribe_objs`
- writes: `add_obj`, `add_objs`, `update_objs`, `replace_objs`, `delete_objs`
- blobs: `add_blob`, `get_blob`, `delete_blobs`
- replication boundary: `read_ops_since`, `latest_seq`, `apply_ops`
- retention: `run_retention`, `get_watermark`, `set_watermark`
- snapshot: `export_snapshot`, `import_snapshot`

## Core Data Model

Every table is identified by:

- `app`
- `db`
- `tableName`
- `tableId`
- `type = "json" | "binary"`

`tableId` is local backend state. It is useful for efficient internal lookup, but it is not portable across snapshot import/export.

### JSON Doc State

Canonical JSON doc state contains:

- internal storage `id`
- stored JSON payload
- tombstone bit
- `updatedAtMs`
- `etag`

Table config contains:

- `indexes`
- `timeField`
- `retentionHours`
- `idPrefix`

### Blob State

Blob state contains:

- blob `id`
- raw `bytes`
- `contentType`
- `sha256`
- `size`

Blobs are stored per table, but `steng` itself does not model semantic links between one JSON doc and one blob. That matters for filtered snapshot export: doc filters cannot automatically decide which blobs belong to which exported rows.

### Oplog State

Each table also has an append-only oplog with:

- `op_seq`
- `ts_ms`
- `op_type`
- `id`
- `payload`

`op_seq` is strictly monotonic per table and forms the replication boundary for `cord` and `netab`.

## ID Strategy

Internal document ids are engine-owned. Application code cannot inject them through `add_obj` or `add_objs`.

Format:

- `{idPrefix}_{clusterShort}_{ULID}`

Why:

- collision resistance without coordination
- origin encoded directly into the id
- sortable high-entropy suffix
- app-level ids can still live in JSON payload and be indexed separately

This keeps storage identity distinct from business identity.

## Backend Layout

### In-Memory Engine

The in-memory engine keeps per-table state in native maps:

- docs map
- blobs map
- oplog array
- watermark
- table info/config

Indexes are not materialized as separate structures. Filter support is validated from config and then evaluated in memory.

### SQL Engine

The SQL-backed engine persists:

- `steng_catalog`
- `steng_docs`
- `steng_doc_index`
- `steng_oplog`
- `steng_watermark`
- `steng_blobs`

Design rationale:

- canonical JSON lives in `steng_docs`
- `steng_doc_index` is derived and rebuildable
- oplog is explicit and durable
- watermark is compact table-level state
- blobs are stored directly for now to keep the reference implementation simple

SQLite and Postgres share the same logical engine through a minimal SQL adapter layer.

## Internal Flows

### Write Path

Normal JSON write flow:

1. resolve and validate table
2. generate internal id when inserting
3. write canonical JSON row
4. rebuild derived index entries for the affected row
5. append oplog row with next `op_seq`
6. publish local change event

Delete flow:

1. mark row as deleted instead of removing all trace
2. keep tombstone metadata
3. remove active index rows
4. append `DELETE` op
5. publish delete event

Why tombstones exist:

- replicas need an explicit delete fact
- absence is ambiguous
- retention and backup need to distinguish deleted from never-existed

### Read Path

Read flow:

1. resolve table
2. verify filter fields are indexed
3. fetch requested ids or candidate ids
4. evaluate filter
5. return paginated rows plus current watermark

JSON filters only operate on live rows. Tombstones are intentionally hidden from the normal read API.

### Remote Apply Path

Remote op apply flow:

1. require `op_seq === latestSeq + 1`
2. apply canonical state mutation
3. append the same op locally
4. publish local event

This keeps local materialized state and local oplog consistent.

### Retention Path

Retention flow:

1. read `timeField` and `retentionHours`
2. compute cutoff
3. tombstone rows older than the cutoff
4. move watermark forward

Retention is expressed as deletes because replicas need to converge on the same resulting absence.

## Snapshot Export/Import Design

Snapshot export/import is a logical state transfer mechanism, not a physical file copy and not a replication log dump.

### Why Logical Snapshots Exist

Primary uses:

- backup
- restore
- migration between backends
- seeding a new environment
- one-time bootstrap before later incremental replication

The important property is portability:

- memory -> SQLite
- SQLite -> Postgres
- Postgres -> memory

### Why NDJSON And Raw Blob Files

The snapshot format intentionally does not use one huge JSON file.

Reasons:

- large exports should not require one giant array in memory
- table data should be readable and debuggable with normal tools
- blobs should remain raw bytes, not base64 inflation inside JSON
- one manifest plus per-table files is easier to inspect incrementally

### Bundle Layout

Canonical directory layout:

```text
manifest.json
tables/<app>/<db>/<table>/schema.json
tables/<app>/<db>/<table>/docs.ndjson
tables/<app>/<db>/<table>/blobs.ndjson
blobs/sha256/ab/cd/<sha256>.bin
```

Archive formats:

- `.tar`
- `.tar.gz`
- `.tgz`

Archive mode is just packaging around the same directory layout. The logical format is the directory structure itself.

### Manifest And Table Files

`manifest.json` stores:

- format version
- creation time
- source backend
- requested export scope
- aggregate counts
- per-table file references

`schema.json` stores:

- `app`
- `db`
- `tableName`
- `sourceTableId`
- `type`
- full `config`
- `watermark`
- effective per-table selection

`docs.ndjson` stores one JSON line per canonical row:

- internal `id`
- `value`
- `meta.updatedAtMs`
- `meta.etag`
- `meta.deleted`

`blobs.ndjson` stores:

- blob `id`
- `contentType`
- `sha256`
- `size`
- relative raw file path

### Scope Model

Supported scope shapes:

- full export of all tables
- export by `app`
- export by `db`
- exact table selection
- exact table selection with one live-row filter

Important behavior:

- filtered exports only select live JSON rows
- filtered exports automatically disable tombstones for that table
- blob export remains table-wide unless `includeBlobs: false`

This is an intentional boundary: `steng` cannot infer doc-to-blob ownership because that relationship belongs to higher-level application data.

### Tombstones In Snapshots

Full-table snapshots can include tombstones.

Why that matters:

- faithful restore
- replica bootstrap
- avoiding resurrection of deleted rows

If tombstones are omitted, the snapshot becomes a live-data-only export instead of a full logical state export.

### Import Semantics

Import preserves:

- internal doc ids
- payloads
- tombstones
- blob ids and bytes
- table config
- watermark

Import does not preserve:

- local numeric `tableId`
- original oplog history
- original `op_seq`

Instead, import synthesizes local restore operations so the destination still has a valid local oplog after import.

That choice is important. If imported rows were written directly with no local oplog, later incremental replication and local diagnostics would see inconsistent state.

### Replace vs Merge

`mode: "replace"`:

- clear docs
- clear blobs
- clear oplog
- clear watermark
- apply snapshot state as the new complete state for each included table

`mode: "merge"`:

- keep local table contents
- import incoming docs and blobs on top
- use conflict handling for duplicate ids
- keep or advance watermark conservatively

Conflict handling:

- `error`
- `skip`
- `replace`

## Snapshot Versus Oplog Replication

These are related but different tools.

Snapshot:

- full logical state at one point in time
- portable across backends
- good for backup/bootstrap/migration

Oplog replication:

- ordered incremental mutations
- good for continuous convergence
- depends on table-local `op_seq`

The intended higher-level replication story is:

1. bootstrap a destination from a snapshot
2. later layer incremental oplog shipping on top

## Adapter Layer

`steng` sits above the small SQL abstraction in [sqldb.ts](../sqldb/sqldb.ts):

- `close`
- `tx`
- `exec`
- `query`
- `queryOne`

Implemented adapters:

- [sqlite_db.ts](../sqldb/sqlite_db.ts)
  - file-backed or in-memory SQLite
  - `better-sqlite3`
- [postgres_db.ts](../sqldb/postgres_db.ts)
  - real `pg`

The current [memory_sql_db.ts](../sqldb/memory_sql_db.ts) remains a simple placeholder/test double for the SQL abstraction itself, not the main storage engine.

## Verification

Key test coverage lives in:

- [steng.test.ts](../tests/steng.test.ts)
- [steng_runtime.test.ts](../tests/steng_runtime.test.ts)
- [steng_snapshot.test.ts](../tests/steng_snapshot.test.ts)
- [sqlite_steng.test.ts](../tests/sqlite_steng.test.ts)
- [postgres_steng.test.ts](../tests/postgres_steng.test.ts)

Covered behavior includes:

- indexed CRUD
- generated ids
- blob storage
- retention and watermarking
- remote op application
- backend portability
- snapshot export/import
- filtered snapshot export
- merge conflict handling on snapshot import
