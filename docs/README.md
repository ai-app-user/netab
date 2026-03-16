# Netab Workspace

This repository is a reference implementation of the architecture described in `context.md`.

It is split into four packages:

- `src/steng`: single-node storage engine with table catalog, JSON/binary records, filters, oplog, subscriptions, and retention.
- `src/cord`: cluster coordination with lease-based leader election and leader-to-replica replication.
- `src/netab`: authenticated network table API, multi-cluster routing/fallback, onboarding helpers, and HTTP wrapper.
- `src/app_helpers/pos`: simplified POS-facing helper built on `netab`.

Top-level folders:

- `docs/`: workspace-level overview.
- `tests/`: cross-package integration tests.
- `playground/`: end-to-end demos.
- `deploy/`: deployment notes.

Quick start:

```bash
npm install
npm run build
npm test
npm run playground
```
