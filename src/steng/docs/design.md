# steng Detailed Design

## Purpose

`steng` is the storage-focused subproject in this repository. It owns single-node persistence semantics and deliberately stops short of network leadership, routing, auth, or product-specific rules.

Responsibilities:

- table catalog management
- canonical object storage
- derived indexes
- append-only oplog
- subscription fanout
- local retention/watermarks
- deterministic remote op apply

Non-goals:

- leader election
- cross-node replication policy
- user auth / RBAC
- cluster routing

Those live in `cord` and `netab`.

## Public API Shape

The public interface is defined in [types.ts](../types.ts) and implemented by:

- [steng_engine.ts](../engine/steng_engine.ts) for the in-memory engine
- [sql_steng_engine.ts](../engine/sql_steng_engine.ts) for SQLite/Postgres-backed engines

Main operations:

- schema: `ensure_table`, `add_index`, `set_table_config`
- reads: `get_objs`, `subscribe_objs`
- writes: `add_obj`, `add_objs` with engine-generated ids, `update_objs`, `replace_objs`, `delete_objs`
- blobs: `add_blob`, `get_blob`, `delete_blobs`
- replication boundary: `read_ops_since`, `latest_seq`, `apply_ops`
- retention: `run_retention`, `get_watermark`, `set_watermark`

## Data Model

Every table is identified by:

- `app`
- `db`
- `tableName`
- `tableId`
- `type` = `json | binary`

JSON table state contains:

- canonical docs keyed by `id`
- tombstone bit
- `updatedAtMs`
- `etag`
- append-only oplog
- table config (`indexes`, `timeField`, `retentionHours`)
- default id generation config (`idPrefix`)

Binary table state contains:

- blob bytes keyed by id
- `contentType`
- `sha256`
- `size`

## Internal Flows

### Write path

1. validate table/type
2. choose id:
   - always generate `{idPrefix}_{clusterShort}_{ULID}`
   - business ids belong inside the JSON payload, not in the storage key
3. write canonical doc or tombstone
4. append oplog record with next `op_seq`
5. publish change event to subscribers

### Read path

1. resolve table
2. verify filter fields are indexed
3. scan current doc state and evaluate filter
4. paginate
5. return current watermark

### Remote apply path

1. accept ops strictly in `latestSeq + 1` order
2. apply each op to canonical local state
3. append op to local oplog
4. publish the same change event locally

### Retention path

1. read `timeField` and `retentionHours`
2. compute cutoff
3. tombstone older docs
4. advance watermark to the newest local cutoff

## Index Design

The in-memory engine stores indexes implicitly in table config and validates filterability, then evaluates filters in memory.

The SQL-backed engines persist the following shape:

- `docs`: canonical JSON rows
- `doc_index`: one row per indexed field per object
- `oplog`: ordered mutations
- `watermarks`
- `blobs`

That split keeps JSON canonical and makes indexes rebuildable. The current SQL implementation stores blob bytes directly in SQL for simplicity.

## Adapter Plan

`steng` should sit above a very small SQL abstraction defined in [sqldb.ts](../sqldb/sqldb.ts):

- `close`
- `tx`
- `exec`
- `query`
- `queryOne`

Implemented adapters:

- `sqlite_db.ts`
  - tablet/dev mode
  - file-backed DB
  - local persistence with `better-sqlite3`
- `postgres_db.ts`
  - server/archive mode
  - connection pooling with `pg`
  - tested through `pg-mem`

The current [memory_sql_db.ts](../sqldb/memory_sql_db.ts) is intentionally minimal and only exists as a placeholder/test double.

## Verification

Backend-specific tests now exist in:

- [sqlite_steng.test.ts](../tests/sqlite_steng.test.ts)
- [postgres_steng.test.ts](../tests/postgres_steng.test.ts)

Covered behavior:

- schema creation
- indexed CRUD
- blob storage
- oplog persistence
- retention and watermarking
- remote op application
