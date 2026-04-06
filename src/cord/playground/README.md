# cord Playground

## Current CLI UX

The current recommended CLI shape is:

```bash
coord [@sender] -command [@target|%cluster] [args...] [--options...]
```

Meaning:

- `@sender`: optional local node selector when more than one local daemon exists
- `-command`: every command starts with one leading `-`
- `@target`: node name or `host:port`
- `%cluster`: cluster selector
- `@./file.txt` or `f:./file.txt`: file payloads for commands like `-echo`

Short examples:

```bash
./scripts/coord -status
./scripts/coord -start:4102 A
./scripts/coord -whoami
./scripts/coord -connect @127.0.0.1:4104 --ttl=0
./scripts/coord -peers
./scripts/coord @D -echo @A "hello from D"
./scripts/coord -cluster:nodes %offline
```

Important behavior:

- If exactly one local daemon exists in the current `COORD_PLAYGROUND_ROOT`, sender selection is implicit.
- If multiple local daemons exist, you must choose the local sender explicitly, for example `coord @A -peers`.
- Any successful RPC learns peer identity automatically.
- `-connect` upgrades one-way reachability into a durable reverse path.
- `-learn` imports remote peer names as suggestions.
- `-route:add` is still available when you want explicit proxy policy.

## Current Commands

Local/system commands:

- `-start[:port] [node_name] [config.json|config.js]`
- `-stop [node_name|all]`
- `-status`
- `-cleanup [local|global]`
- `-discover [port1[,port2...]] [ttl_in_secs]`
- `-save [path.json]`
- `-load [path.json]`
- `-help [group|group:cmd]`

Foundation commands:

- `-whoami [@target]`
- `-ping @target`
- `-echo [@target] [args...] [@./file|f:./file|@-]`
- `-sleep [@target] 200`
- `-peers [@target]`
- `-routes [@target]`
- `-connect @target --ttl=0`
- `-disconnect @target`
- `-learn @target`
- `-route:add @dst [@proxy]`
- `-route:del @dst`
- `-route:deny @dst [in|out|both]`
- `-proxy:on [@dst]`
- `-proxy:off`

Cluster / IAM / election commands:

- `-cluster:create %cluster`
- `-cluster:join %cluster`
- `-cluster:leave %cluster`
- `-cluster:nodes %cluster`
- `-cluster:exec %cluster method=cord.foundation.whoami`
- `-iam:defineCommand ...`
- `-iam:grant ...`
- `-iam:canInvoke ...`
- `-users:ensureGuest`
- `-bootstrap:register_unallocated`
- `-bootstrap:list_unallocated`
- `-election:addShard %cluster ...`
- `-election:getLeader %cluster ...`

## Verified Examples

### 1. Single Local Node

Start one node and use implicit sender selection:

```bash
./scripts/coord -start:4102 A
./scripts/coord -status
./scripts/coord -whoami
./scripts/coord -peers
```

Expected:

- `-whoami` runs on `A`
- `-peers` is empty until `A` talks to another node

### 2. Direct Learning By IP

This is the simplest way to learn a remote peer name from an address.

```bash
./scripts/coord -start:4101 A
./scripts/coord -start:4104 P

./scripts/coord @A -whoami @127.0.0.1:4104
./scripts/coord @A -peers
./scripts/coord @P -peers
```

Typical result:

```text
coord peers on A

NAME      VIA               WAYS   TTL      STATE
P         127.0.0.1:4104    out    298s     learned
```

```text
coord peers on P

NAME      VIA               WAYS   TTL      STATE
A         127.0.0.1:4101    in     298s     learned
```

This is the one-way case:

- `A` learned that it can send to `P`
- `P` learned that `A` reached it
- there is no reverse path yet

### 3. Reverse Connect

Now upgrade that one-way direct reachability into a durable reverse path.

```bash
./scripts/coord @A -connect @127.0.0.1:4104 --ttl=0
./scripts/coord @A -peers
./scripts/coord @P -peers
./scripts/coord @P -whoami @A
```

Typical result:

```text
coord peers on A

NAME      VIA               WAYS   TTL      STATE
P         127.0.0.1:4104    both   -        connected
```

```text
coord peers on P

NAME      VIA               WAYS   TTL      STATE
A         reverse           both   -        connected
```

`reverse` means:

- `A` initiated the long-lived connection into `P`
- `P` can now reach `A` over that reverse path
- path rendering uses `-<` for that last hop

### 4. Learn Peers From A Proxy

With one more node `D` on the same side as `P`, import `A` as a suggested peer:

```bash
./scripts/coord -start:4105 D
./scripts/coord @D -learn @P
./scripts/coord @D -peers
```

Typical result:

```text
coord peers on D

NAME      VIA               WAYS   TTL      STATE
A         via P             -      298s     suggested
P         127.0.0.1:4104    out    298s     learned
```

This means:

- `D` knows `A` exists
- `P` claims it can reach `A`
- `D` has not verified that path yet

### 5. Proxy To Reverse Hop: `D -> P -< A`

Add explicit policy on `D`, then execute through `P`.

```bash
./scripts/coord @D -route:add @A @P
./scripts/coord @D -echo @A "hello from D" --verbose
```

Expected route shape:

```text
D -> P -< A
```

That means:

- `D -> P`: normal direct hop
- `P -< A`: reverse hop that uses the connection `A` opened into `P`

### 6. Reply Path Learned On `A`

After `D` reaches `A` through `P`, `A` learns that `D` exists via `P`:

```bash
./scripts/coord @A -peers
./scripts/coord @A -routes
```

Typical result:

```text
coord peers on A

NAME      VIA               WAYS   TTL      STATE
D         via P             in     298s     learned
P         127.0.0.1:4104    both   -        connected
```

If you want to force the reply to use the learned proxy path instead of any direct local shortcut, deny direct outbound first:

```bash
./scripts/coord @A -route:deny @D out
./scripts/coord @A -whoami @D --verbose
```

Expected path:

```text
A -> P -> D
```

### 7. Proxy Mode Default Destination

You can make one node behave like a shell pointed at another destination:

```bash
./scripts/coord @A -proxy:on @D
./scripts/coord @A -whoami
./scripts/coord @A -proxy:off
```

While proxy mode is on:

- commands without `@target` default to `D`
- explicit `@target` still overrides it

### 8. File Payloads

Both forms are supported:

```bash
./scripts/coord @A -echo @P @./src/cord/playground/samples/bigfile.txt
./scripts/coord @A -echo @P f:./src/cord/playground/samples/bigfile.txt
cat ./src/cord/playground/samples/bigfile.txt | ./scripts/coord @A -echo @P @-
```

## Legacy Notes

Older target-first examples remain below for historical context, but the recommended syntax is now the `[@sender] -command [@target|%cluster]` form documented above.

This folder now exposes the design-doc CLI directly through [`scripts/coord`](/home/user/src/netab/scripts/coord).

If you want the exact command shape from the `coord_cli` chapter, use:

```bash
./scripts/coord
./scripts/coord -help
```

There is still a convenience npm entrypoint:

```bash
npm run cord:playground:coord -- -help
```

Wrapper: `src/cord/playground/coord.ts`

Core CLI/runtime: `src/cord/coord_runtime.ts`
CLI entrypoint: `src/cord/coord_main.ts`

## 1. CLI Commands Present In The Playground

Base commands:

- `-start[:port] [node_name] [config.json|config.js]`
- `-stop [node_name|all]`
- `-status`
- `-cleanup [local|global]`
- `-discover [port1[,port2...]] [ttl_in_secs]`
- `-save [path.json]`
- `-load [path.json]`
- `-help [group|group:cmd]`

Targeted foundation commands:

- `whoami`
- `ping`
- `echo`
- `sleep`
- `route print`
- `route add <dst>`
- `route add <dst> <proxy>`
- `route deny [in|out] <dst>`
- `route del <dst>`
- `proxy on [dst]`
- `proxy off`

Universal routing option:

- `--dst=<node>` or `--dst <node>`
- `--verbose`

Targeted cluster commands:

- `cluster:create`
- `cluster:join`
- `cluster:leave`
- `cluster:listNodes`
- `cluster:execOnCluster`

Targeted IAM / bootstrap / election commands:

- `iam:defineCommand`
- `iam:grant`
- `iam:canInvoke`
- `users:ensureGuest`
- `bootstrap:register_unallocated`
- `bootstrap:list_unallocated`
- `election:addShard`
- `election:getLeader`

## 2. First Try-Out

Start three nodes:

```bash
./scripts/coord -start:4101 A ./src/cord/playground/configs/A.json
./scripts/coord -start:4102 B ./src/cord/playground/configs/B.json
./scripts/coord -start:4103 C ./src/cord/playground/configs/C.json
```

Discover them:

```bash
./scripts/coord -discover 4101,4102,4103 600
```

See what is actually running:

```bash
./scripts/coord -status
```

Run foundation calls:

```bash
./scripts/coord A whoami
./scripts/coord A --dst=B whoami
./scripts/coord B ping
./scripts/coord B echo test works
./scripts/coord B sleep ms=100
./scripts/coord B echo @./src/cord/playground/samples/bigfile.txt
cat ./src/cord/playground/samples/bigfile.txt | ./scripts/coord B echo @-
```

Routing / proxy examples:

```bash
./scripts/coord A route print
./scripts/coord A route print --verbose
./scripts/coord A route deny out C
./scripts/coord A --dst=C whoami
./scripts/coord A route add D P
./scripts/coord A --dst=D whoami
./scripts/coord A proxy on D
./scripts/coord A whoami
./scripts/coord A --dst=A whoami
./scripts/coord A proxy off
```

Ask for help:

```bash
./scripts/coord -help
./scripts/coord -help foundation
./scripts/coord -help foundation:echo
./scripts/coord -help cluster
```

Stop them again:

```bash
./scripts/coord -stop all
./scripts/coord -cleanup
```

## 3. Cluster / IAM / Election Examples

Create and inspect a cluster:

```bash
./scripts/coord A cluster:create clusterId=offline
./scripts/coord A cluster:join clusterId=offline
./scripts/coord B cluster:join clusterId=offline
./scripts/coord A cluster:listNodes clusterId=offline
```

Fan out a command:

```bash
./scripts/coord #offline cluster:execOnCluster method=cord.foundation.whoami
```

IAM examples:

```bash
./scripts/coord A iam:defineCommand ns=default commandId=cmd:test title=Test
./scripts/coord A iam:grant ns=default subject=grp:guest commandId=cmd:test allow=true
./scripts/coord A iam:canInvoke ns=default userId=user:guest commandId=cmd:test
```

Bootstrap and election examples:

```bash
./scripts/coord A bootstrap:list_unallocated ns=default
./scripts/coord A election:addShard clusterId=offline shardId=orders weight=2
./scripts/coord A election:getLeader clusterId=offline shardId=orders
```

## 4. Files And State

The CLI playground persists state under `tmp/cord_foundation` by default:

- `coord.nodes.json`: started playground nodes and their current persisted `nodeEpoch`
- `coord.cache.json`: discovery cache used for name -> addr resolution
- `coord.store.json`: shared `FileJsonStore` backing foundation route policy/observations, cluster, IAM, bootstrap, and election state

You can change the root with:

```bash
COORD_PLAYGROUND_ROOT=./tmp/my-cord ./scripts/coord -help
```

## 5. Other Runnable Demos

These are still useful as focused code examples:

- `npm run cord:playground:foundation`
- `npm run cord:playground:basic`

Backed by:

- `src/cord/playground/foundation.ts`
- `src/cord/playground/basic.ts`
