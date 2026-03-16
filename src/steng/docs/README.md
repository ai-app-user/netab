# steng

`steng` is the single-node storage engine for the wider `netab` stack.

It is responsible for:

- table catalog and schema metadata
- JSON and binary object storage
- derived indexes for filtered reads
- append-only oplog generation
- subscriptions/change fanout
- watermarks and retention
- deterministic remote op application

Current implementation status:

- shipped: high-level `Steng` facade in [steng.ts](../steng.ts) that selects memory, SQLite, or Postgres by config
- shipped: in-memory reference engine in [steng_engine.ts](../engine/steng_engine.ts)
- shipped: simple `SqlDb` abstraction in [sqldb.ts](../sqldb/sqldb.ts)
- shipped: SQLite adapter in [sqlite_db.ts](../sqldb/sqlite_db.ts)
- shipped: Postgres adapter in [postgres_db.ts](../sqldb/postgres_db.ts)
- shipped: SQL-backed engine in [sql_steng_engine.ts](../engine/sql_steng_engine.ts)

Public surface:

- `new Steng({ backend: "memory" | "sqlite" | "postgres" })`
- `new Steng({ backend: "sqlite", sqlite: { filename: "./steng.sqlite" } })`
- `new Steng({ backend: "postgres", postgres: { connectionString: "postgres://..." } })`
- `ensure_table`, `get_table_info`, `list_tables`, `drop_table`
- `add_index`, `set_table_config`
- `get_objs`, `subscribe_objs`
- `add_obj`, `add_objs` returning generated ids, `update_objs`, `replace_objs`, `delete_objs`
- `add_blob`, `get_blob`, `delete_blobs`
- `read_ops_since`, `latest_seq`, `apply_ops`
- `run_retention`, `get_watermark`, `set_watermark`

Key invariants:

- JSON rows are canonical; indexes are derived views.
- Every write appends an oplog entry with monotonic `op_seq`.
- Deletes become tombstones so replicas converge.
- Filters require indexed fields.
- `add_obj` and `add_objs` always generate origin-encoded internal ids.
- application/business ids should live inside the JSON payload and be indexed if queried.
- `update_objs` deep-merges by default.
- Remote op application is sequential and idempotent by `(tableId, op_seq)`.

Generated ID format:

- `{idPrefix}_{clusterShort}_{ULID}`
- default `idPrefix` comes from `tableName`
- `clusterShort` comes from engine identity options

Design docs:

- [design.md](./design.md): architecture, data model, internal flows, and adapter plan

Try it quickly:

- `npm run steng:playground:basic`
- `npm run steng:playground:sqlite`
- `npm run steng:playground:postgres`
- `npm run steng:playground:subscriptions`
- `npm run steng:playground:retention`

Folder map:

- `sqldb/`: minimal SQL adapter contract and placeholder in-memory DB driver
- `engine/`: low-level backend implementations
- `steng.ts`: high-level facade that picks the backend
- `tests/`: storage-level tests
- `playground/`: runnable examples with step-by-step docs
- `deploy/`: installation/configuration scripts for SQLite/Postgres environments
