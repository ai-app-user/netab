# steng

`steng` is the single-node storage engine for the wider `netab` stack.

It owns:

- table catalog and schema metadata
- JSON and binary object storage
- derived indexes for filtered reads
- append-only oplog generation
- subscriptions/change fanout
- watermarks and retention
- deterministic remote op application
- logical snapshot export/import

It does not own:

- leader election
- cross-node replication policy
- auth / RBAC
- cluster routing

Those live above `steng`.

## Public Surface

Construct the high-level facade and let it choose the backend:

- `new Steng({ backend: "memory" | "sqlite" | "postgres" })`
- `new Steng({ backend: "sqlite", sqlite: { filename: "./steng.sqlite" } })`
- `new Steng({ backend: "postgres", postgres: { connectionString: "postgres://..." } })`

Main API groups:

- schema: `ensure_table`, `get_table_info`, `get_table_info_by_id`, `list_tables`, `drop_table`
- indexes/config: `add_index`, `list_indexes`, `set_table_config`
- reads: `get_objs`, `subscribe_objs`
- writes: `add_obj`, `add_objs`, `update_objs`, `replace_objs`, `delete_objs`
- blobs: `add_blob`, `get_blob`, `delete_blobs`
- oplog/replication: `read_ops_since`, `latest_seq`, `apply_ops`
- retention: `run_retention`, `get_watermark`, `set_watermark`
- snapshot export/import: `export_snapshot`, `import_snapshot`

## Snapshot Export/Import

`steng` now supports backend-independent logical snapshots.

What a snapshot preserves:

- table identity by `app/db/tableName`
- table type and full `TableConfig`
- internal document ids
- live JSON docs
- tombstones when requested
- blobs and blob metadata
- current watermark

What a snapshot does not preserve:

- numeric local `tableId` values
- original oplog history and original `op_seq`

On import, `steng` recreates local oplog entries with synthetic restore operations so the imported table still behaves like a normal local table afterwards.

### Output Formats

`export_snapshot({ outputPath })` supports:

- directory bundle: any path without an archive extension
- tar archive: path ending in `.tar`
- gzip tar archive: path ending in `.tar.gz` or `.tgz`

The same logical bundle layout is used in every case. Archive mode is just packaging around the directory structure.

### Bundle Layout

Snapshot contents look like this:

```text
manifest.json
tables/<app>/<db>/<table>/schema.json
tables/<app>/<db>/<table>/docs.ndjson
tables/<app>/<db>/<table>/blobs.ndjson
blobs/sha256/ab/cd/<sha256>.bin
```

Why this shape:

- `manifest.json` gives one quick summary for inspection and automation
- `schema.json` keeps table config next to table data
- `docs.ndjson` is stream-friendly and avoids one huge array
- raw blob bytes stay outside JSON
- content-addressed blob files avoid duplicate payload copies inside one export

### Scope Model

You can export:

- all tables
- selected `app` values
- selected `db` values
- exact tables by `app/db/tableName`
- one filtered subset of live rows for a specific table

Example:

```ts
await steng.export_snapshot({
  outputPath: "./tmp/orders.tar.gz",
  scope: {
    tables: [
      {
        app: "pos",
        db: "miami1",
        tableName: "orders",
        filter: [["status", "==", "READY"]],
        includeBlobs: false,
      },
    ],
  },
});
```

Important rules:

- table filters apply only to live JSON docs
- when a table filter is used, tombstones for that table are omitted
- blob export is table-wide because `steng` does not know which blobs are semantically linked to which JSON docs
- if you need a filtered JSON export without unrelated blobs, set `includeBlobs: false`

### Import Modes

`import_snapshot({ ... })` supports:

- `mode: "replace"`
  - clear each included table first, then restore exactly what is in the snapshot
- `mode: "merge"`
  - keep existing table contents and apply imported rows/blobs on top

Conflict handling in merge mode:

- `conflictMode: "error"`
- `conflictMode: "skip"`
- `conflictMode: "replace"`

## Key Invariants

- JSON rows are canonical; indexes are derived views.
- Every normal write appends an oplog entry with monotonic `op_seq`.
- Deletes become tombstones so replicas converge.
- Filters require indexed fields.
- `add_obj` and `add_objs` always generate origin-encoded internal ids.
- application/business ids should live inside the JSON payload and be indexed if queried.
- `update_objs` deep-merges by default.
- Remote op application is sequential and idempotent by `(tableId, op_seq)`.
- snapshot import preserves internal doc ids but remaps local numeric table ids.

Generated ID format:

- `{idPrefix}_{clusterShort}_{ULID}`
- default `idPrefix` comes from `tableName`
- `clusterShort` comes from engine identity options

## Design Docs

- [design.md](./design.md): architecture, data model, write/read/retention/import-export flows, and bundle format rationale

## Try It Quickly

- `npm run steng:playground:basic`
- `npm run steng:playground:sqlite`
- `npm run steng:playground:postgres`
- `npm run steng:playground:snapshot`
- `npm run steng:playground:subscriptions`
- `npm run steng:playground:retention`

## Folder Map

- `sqldb/`: minimal SQL adapter contract and SQL drivers
- `engine/`: low-level backend implementations plus bundle I/O
- `steng.ts`: high-level facade that picks the backend
- `tests/`: storage-level tests
- `playground/`: runnable examples with step-by-step docs
- `deploy/`: installation/configuration scripts for SQLite/Postgres environments
