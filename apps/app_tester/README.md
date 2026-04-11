# app_tester

`app_tester` is the Android playground shell for this repository.

Current scope:

- verify the APK/update pipeline on a real tablet
- run a real embedded Android `coord` node inside the app process
- verify local app-private SQLite works
- persist Android-local route state and local steng data in SQLite
- persist Android-local node definition and persistent reverse-connect intents in the same SQLite DB
- verify saved settings persist across reopen
- verify the tablet can reach a remote `coord` sender node
- drive real `cord.foundation.*` RPCs against either the embedded Android node or a running sender node on Linux/VPS
- inspect peers and routes from the phone
- trigger connect, learn, route, proxy, echo, and sleep flows from the phone
- create local steng tables/docs inside the phone app without Node.js

## Build Notes

This project does not currently ship a Gradle wrapper. Open it in Android Studio, sync the project, and build a debug or release APK there.

Then either:

- install with `adb install -r`
- or publish the APK via [`deploy/android/README.md`](/home/user/src/netab/deploy/android/README.md) and pick it up through `android_deployer`

## Current Screen

The tester is now a guided mobile playground with three steps:

1. select which app area to test:
   - `coord`
   - `steng`
2. select a command from that area
3. fill only the parameters needed for that command and run it

The UI now gives you:

- a proper top inset so the content does not collide with the Android status bar
- a short current environment summary
- a command description area
- `?` help for the selected command
- `?` help for every visible parameter
- immediate command output right below the run button
- recent history under the latest output

For `coord`, the guided command list covers:

- local embedded node start / stop / status
- switching to the local sender URL
- sender `/healthz`
- host shell `exec` on sender or routed target
- sender and target `whoami`
- target `ping`
- `peers`
- `routes`
- `connect`
- `learn`
- `disconnect`
- route add / delete / deny
- proxy on / off
- `echo`
- `sleep`
- raw sender and target RPC
- copying the VPS proxy-route commands for `D -> P -< A`

For `steng`, the guided command list covers:

- SQLite smoke test
- ensure local table
- add local document
- list local documents

This is much closer to the Linux playground mentally, but in a phone-appropriate step flow instead of a wall of buttons and fields.

`exec` in the phone UI is intended for remote Linux/Windows/macOS nodes. If you point it at the embedded Android node, it returns a clear structured `supported=false` result instead of trying to expose a fake shell.

## Suggested First Test: Embedded Android Node

1. Install `app_tester` on the phone.
2. Select app: `coord`.
3. Select command: `Local: Start embedded node`.
4. Leave:
   - node alias: `A`
   - local port: `4001`
5. Run it.
6. Select command: `Local: Use local sender URL`, then run it.
7. Select command: `Foundation: Sender whoami`, then run it.
8. Select command: `Foundation: Show peers`, then run it.
9. Select command: `Foundation: Show routes`, then run it.

At that point, the phone is exercising a real local `coord` node hosted inside the Android app.

If you close and reopen the app:

- the local node definition is restored automatically from SQLite
- the sender URL is switched back to the local embedded node
- persistent reverse connects are replayed automatically
- runtime-only connects are not replayed

## Suggested First Test: Local Steng

1. Select app: `steng`.
2. Select command: `Steng: Ensure table`, leave the defaults, and run it.
3. Select command: `Steng: Add document`, leave the defaults, and run it.
4. Select command: `Steng: List documents`, and run it.

That verifies:

- app-private SQLite works
- local steng metadata persists
- local steng docs are created on-device without any external server

## Suggested First Test: Phone `A` To VPS `P`

1. On the VPS:
   - `./scripts/coord -start:4104 P`
   - `./scripts/coord -start:4105 D`
2. In `app_tester`:
   - select `coord`
   - run `Local: Start embedded node`
   - run `Local: Use local sender URL`
   - run `Foundation: Connect target` with target `157.250.198.83:4104` and blank TTL
3. Change target to `P`.
4. Run:
   - `Foundation: Show peers`
   - `Foundation: Show routes`
   - `Foundation: Target whoami`

That tests:

- Android local node `A`
- outbound connect from `A` to VPS proxy `P`
- peer learning between the phone and the VPS

TTL semantics in the phone UI match the Linux CLI:

- blank TTL: persistent forever
- `0`: runtime-only, do not restore after app restart
- positive TTL: persistent until that expiry

## Suggested Proxy Test: `D -> P -< A`

After the phone has connected to `P`, on the VPS run:

```bash
./scripts/coord @D -learn @P
./scripts/coord @D -route:add @A @P
./scripts/coord @D -echo @A "hello from D"
```

Back in `app_tester`, run:

- `Foundation: Show peers`
- `Foundation: Show routes`

You should see that the phone has learned `D` through `P`, and the Linux side should render the path as:

```text
D -> P -< A
```

## Raw RPC

The raw RPC commands are the escape hatch for anything not yet mapped to a dedicated guided command. Examples:

- `cord.foundation.whoami` with `{}`
- `cord.cluster.listNodes` with `{"clusterId":"offline"}`
- `cord.election.getLeader` with `{"clusterId":"offline","shardId":"default"}`

Use `Raw call on target` when the method should be executed on the current target through the selected sender.
