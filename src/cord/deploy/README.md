# cord Deploy

`cord` is no longer just a replication tick wrapper. The current implementation is a generic coordinator stack with:

- foundation RPC/discovery
- cluster membership and liveness
- IAM groups/users/commands/grants
- bootstrap for unallocated nodes
- shard leader election
- optional legacy `steng` replication glue through `replicate_tick()`

## Typical Runtime Shapes

### 1. Node starts unallocated

Use this when a new tablet or device should not auto-join a real cluster yet:

```ts
const node = new CordNode(registry, {
  nodeId: "tablet-01",
});

await node.start();
```

Behavior:

- the node starts foundation RPC
- it registers itself in bootstrap as unallocated
- only cheap guest-safe RPCs are open without explicit auth

### 2. Node starts already attached to a cluster

Use this for known infrastructure nodes or tests:

```ts
const node = new CordNode(registry, {
  nodeId: "offline-a",
  clusterId: "offline",
  priority: 10,
  eligible: true,
});

await node.start();
```

Behavior:

- the node auto-creates the cluster if needed
- it auto-joins with a default role
- it auto-adds the default shard
- heartbeat and election loops start automatically

## Persistence Choices

`cord` can run with or without durable state.

### Ephemeral memory

Default:

```ts
const registry = new CordRegistry();
const node = new CordNode(registry, { nodeId: "n1" });
```

This is good for tests and short-lived local processes.

### File-backed JSON store

Use `FileJsonStore` when you want cluster/IAM/bootstrap state to survive process restarts:

```ts
const store = new FileJsonStore("./data/cord.json");
const registry = new CordRegistry(store);
const node = new CordNode(registry, {
  nodeId: "router-1",
  store,
  clusterId: "offline",
});
```

Persisted now:

- cluster specs
- cluster membership configs
- IAM users/groups/commands/grants
- bootstrap unallocated registry
- shard specs
- leader assignment cache

Still volatile:

- runtime lease votes
- in-memory alive view

## Operational Notes

### Heartbeats

Each running node sends cluster heartbeats on an internal interval. You normally do not need to drive this manually.

Relevant options:

- `heartbeatMs`
- `electionIntervalMs`
- `leaseMs`
- `leaseMode`

### Leader election

Leaders are per shard.

Use:

```ts
await node.addShard("offline", { shardId: "orders", weight: 3 });
await node.addShard("offline", { shardId: "payments", weight: 1 });

const leader = await node.getLeader("offline", "orders");
```

### Optional `steng` glue

If a node is constructed with `steng`, the compatibility method `replicate_tick()` still performs the old oplog replication behavior for the node’s default cluster:

```ts
await node.replicate_tick();
```

This is kept so the existing `netab` integration continues to work. It is not the core purpose of `cord`.

## Minimal Bring-Up Checklist

For a small embedded cluster:

1. Create one shared `CordRegistry`.
2. Create one `CordNode` per process/device.
3. Give each node a stable `nodeId`.
4. Pass `clusterId` only for already-approved members.
5. Call `start()` once.
6. Add any extra shards you need.

For a VPS/router plus tablets:

1. Start routers with persistent `FileJsonStore`.
2. Start tablets unallocated by default.
3. Use bootstrap + higher-level pairing flow to claim and attach tablets.
4. Use IAM grants instead of assuming membership implies permission.
