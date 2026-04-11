# Netab Workspace

This repository is a reference implementation of the architecture described in `context.md`.

It is split into four packages:

- `src/steng`: single-node storage engine with table catalog, JSON/binary records, filters, oplog, subscriptions, and retention.
- `src/cord`: cluster coordination with lease-based leader election and leader-to-replica replication.
- `src/netab`: authenticated network table API, multi-cluster routing/fallback, onboarding helpers, and HTTP wrapper.
- `src/app_helpers/pos`: simplified POS-facing helper built on `netab`.

It also includes Android-facing app projects:

- `apps/android_deployer`: stable OTA-style installer/updater shell for Fire tablet / Android testing.
- `apps/app_tester`: Android tester shell for packaging, SQLite environment checks, network probes, and later embedded `steng` / `cord` validation.

Top-level folders:

- `docs/`: workspace-level overview.
- `tests/`: cross-package integration tests.
- `playground/`: end-to-end demos.
- `deploy/`: deployment notes.
- `apps/`: Android-native projects and their docs.

Quick start:

```bash
npm install
npm run build
npm test
npm run playground
```

API docs and coverage:

```bash
npm run docs:api
npm run test:coverage
```

This writes hover-friendly HTML API documentation to `docs/api/` using TypeDoc and writes the HTML coverage report to `coverage/`.

Android artifact publishing and OTA update flow are documented in [`deploy/android/README.md`](/home/user/src/netab/deploy/android/README.md).
