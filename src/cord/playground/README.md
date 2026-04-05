# cord Playground

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
