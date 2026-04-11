# Android Apps

This workspace now has two Android-facing projects outside `src/`:

- `apps/android_deployer`: stable installer/updater shell used for over-the-air APK pickup from the VPS.
- `apps/app_tester`: frequently updated tester/playground app used to validate Android packaging, local SQLite availability, network reachability to the VPS, and later `steng` / `cord` integration.

Why they live outside `src/`:

- `src/` is the TypeScript/Node reference implementation area.
- `apps/` is for Android-native delivery surfaces.
- `app_tester` is expected to consume concepts from `steng`, `cord`, `netab`, and future Android adapters, but it should not distort the current Linux/Node package layout.

Current state:

- the OTA artifact format, channel layout, and VPS hosting flow are implemented under [`deploy/android/README.md`](/home/user/src/netab/deploy/android/README.md)
- `android_deployer` is a small native shell that checks a manifest URL and opens the referenced APK for install/update
- `app_tester` is a native tester shell that now starts a real embedded Android `coord` node, stores local route state and local steng docs in SQLite, probes remote VPS nodes, and exercises routing/reverse-connect flows from the phone

The Android projects are intentionally outside the root TypeScript build/test path, so `npm run build` and `npm test` remain Linux-safe even on machines without Android SDK tools.
