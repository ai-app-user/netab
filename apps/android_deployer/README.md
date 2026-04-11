# android_deployer

`android_deployer` is the stable Android shell used to verify the non-ADB update flow.

Its job is intentionally narrow:

- check a `latest.json` manifest on the VPS
- compare the installed app version against the latest available build
- expose a single clear install/update action when needed
- open the referenced APK URL so Android can download/install the update

This app should change infrequently compared with `app_tester`.

## Intended Tablet UX

1. install `android_deployer` once
2. publish `app_tester/dev` to the VPS
3. open `android_deployer`
4. let it auto-check the default feed
5. tap `Install` or `Update` when shown
6. confirm Android’s install/update prompt

That gives a realistic OTA-style update flow with a small number of taps.

## Current Default Feed

The deployer defaults to the VPS IP-based feed rather than the hostname so it works even when device DNS is unreliable:

- `http://157.250.198.83/netab/android/app_tester/dev/latest.json`

The advanced section still lets you replace that feed and store a different manifest URL for future launches.

## Build Notes

This project is an Android Studio / Gradle project, but the repository does not currently ship a Gradle wrapper because the Linux workspace used for the Node code does not have Java/Gradle/Android SDK installed.

Use Android Studio to:

1. open `apps/android_deployer`
2. let it sync dependencies
3. build `app-debug.apk` or a signed release APK

Then publish the APK with the repo-level scripts described in [`deploy/android/README.md`](/home/user/src/netab/deploy/android/README.md).
