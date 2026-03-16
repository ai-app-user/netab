# cord

`cord` coordinates a cluster of nodes around leader election and replication.

Public surface:

- `CordRegistry`: in-process registry used by the reference implementation.
- `CordNode`: node handle with `start`, `stop`, `get_leader`, `get_cluster_status`, `set_reachability`, and `replicate_tick`.

Behavior:

- leader election is lease-based
- only leader-eligible nodes can win
- a leader must be reachable by all active replicas
- replication is oplog-based from leader to replicas

Threat model:

- `cord` assumes a trusted transport in this reference implementation
- production deployments should add node authentication for RPC and heartbeat traffic
