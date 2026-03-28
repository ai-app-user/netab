# steng Playground

This folder is for quick, low-friction experiments with the storage engine.

## Requirements

From the repo root:

```bash
npm install
```

## Scripts

### 1. Basic CRUD

```bash
npm run steng:playground:basic
```

Backed by: `src/steng/playground/basic.ts`

What it shows:

- choose backend with one setting: `memory`, `sqlite`, or `postgres`
- instantiate one high-level `Steng` class instead of engine-specific classes
- create a table
- add indexes
- list indexes
- configure `timeField` and `idPrefix`
- insert with engine-generated ids
- store app-level keys inside the JSON payload when needed
- read by id
- paginated full-table reads
- filter queries with `==`, `in`, `contains`, and id `prefix`
- update
- replace
- delete
- inspect oplog

You can also run the same file directly with a backend switch:

```bash
tsx src/steng/playground/basic.ts --backend memory
tsx src/steng/playground/basic.ts --backend sqlite
tsx src/steng/playground/basic.ts --backend postgres
```

Or via environment variable:

```bash
STENG_BACKEND=sqlite tsx src/steng/playground/basic.ts
STENG_CLUSTER_SHORT=mi1a tsx src/steng/playground/basic.ts --backend memory
```

The shared playground now does:

```ts
const steng = new Steng({ backend: "sqlite", clusterShort: "mi1a" });
```

The backend-specific initialization is handled inside `src/steng/steng.ts`.

### 2. Snapshot Export/Import

```bash
npm run steng:playground:snapshot
```

Backed by: `src/steng/playground/snapshot.ts`

What it shows:

- create a source dataset
- export a backend-independent snapshot bundle
- restore the same snapshot into another backend
- preserve internal ids, tombstones, blobs, and watermarks
- print the manifest plus the restored rows

Useful direct forms:

```bash
tsx src/steng/playground/snapshot.ts --backend memory --restore-backend sqlite
tsx src/steng/playground/snapshot.ts --backend sqlite --restore-backend postgres --out ./tmp/orders.tar.gz
```

Or with environment variables:

```bash
STENG_BACKEND=postgres STENG_RESTORE_BACKEND=memory tsx src/steng/playground/snapshot.ts
STENG_SNAPSHOT_OUT=./tmp/orders.tar.gz tsx src/steng/playground/snapshot.ts --backend sqlite
```

### 3. Subscriptions

```bash
npm run steng:playground:subscriptions
```

Backed by: `src/steng/playground/subscriptions.ts`

What it shows:

- filtered subscriptions
- add/update/delete events
- unsubscribe flow

### 4. Retention

```bash
npm run steng:playground:retention
```

Backed by: `src/steng/playground/retention.ts`

What it shows:

- time-based retention config
- watermark advancement
- old rows being tombstoned

### 5. SQLite backend

```bash
npm run steng:playground:sqlite
```

Backed by: `src/steng/playground/sqlite.ts`

What it shows:

- the same basic CRUD flow as `basic.ts`
- backend set to SQLite
- kept as a small compatibility entrypoint if you want a dedicated file name

### 6. Postgres backend

```bash
npm run steng:playground:postgres
```

Backed by: `src/steng/playground/postgres.ts`

What it shows:

- the same basic CRUD flow as `basic.ts`
- backend set to Postgres
- uses embedded `pg-mem` by default so it works without a server
- kept as a small compatibility entrypoint if you want a dedicated file name

## How to Extend a Playground

All playgrounds should:

- import from `src/steng/index.ts`
- create their own isolated engine instance
- print the intermediate state clearly
- fail fast on unexpected behavior

The goal is fast manual verification, not framework-heavy demos.
