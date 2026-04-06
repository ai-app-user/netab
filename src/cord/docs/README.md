# cord Architecture And Design

Implementation status in this repo:

- implemented: `CoordStore`, `MemoryStore`, `FileJsonStore`
- implemented: foundation RPC/discovery plus per-node route tables, deny rules, single-hop proxying, and universal `--dst` forwarding
- implemented: cluster specs, membership, heartbeats, alive view, cluster fanout
- implemented: IAM groups/users/commands/grants
- implemented: bootstrap unallocated registration
- implemented: per-shard election with balancing and lease RPC
- implemented: `coord_cli` parsing/dispatch runtime
- implemented: optional legacy `steng` replication glue on `CordNode.replicate_tick()`

This document covers `cord` only: the coordinator / connectivity / IAM stack that everything else builds on. It is intentionally table-agnostic until the optional glue layer.

The goal is to keep clean boundaries between:

- foundation RPC
- cluster membership
- IAM
- election
- bootstrap
- CLI parsing/dispatch

The detailed design below is the target model this implementation follows.

Quick try-out:

- `./scripts/coord -help`
- `./scripts/coord -start:4101 A ./src/cord/playground/configs/A.json`
- `./scripts/coord -status`
- `./scripts/coord -stop all`
- `./scripts/coord -cleanup`
- `./scripts/coord -discover 4101 600`
- `./scripts/coord A whoami`
- `./scripts/coord A route print`
- `./scripts/coord A route add D P`
- `./scripts/coord A --dst=D whoami`
- `./scripts/coord A proxy on D`
- `npm run cord:playground:foundation`
- `npm run cord:playground:basic`
- `npm run cord:playground:coord -- -help`

Playground docs:

- [playground/README.md](../playground/README.md)

Current CLI UX update:

- current recommended syntax: `coord [@sender] -command [@target|%cluster] [args...] [--options...]`
- `@name` or `@host:port` selects a node
- `%cluster` selects a cluster
- `@./file.txt` or `f:./file.txt` passes a file payload
- when exactly one local daemon exists in the current root, `@sender` is implicit
- when multiple local daemons exist, `@sender` is required for commands that need local execution context

Current foundation UX additions implemented in this repo:

- automatic peer learning on successful RPCs
- `-peers` to show learned peer identity/path state
- `-routes` to show effective routing policy and path shape
- `-connect` to create a durable reverse path
- `-learn` to import peer suggestions from another node
- explicit proxy policy with `-route:add`
- proxy default mode with `-proxy:on` / `-proxy:off`

Current path notation:

- `A -> B`: normal direct hop
- `D -> P -> A`: normal proxied path
- `D -> P -< A`: proxied path whose last hop uses a reverse connection opened by `A`

Current peer/routing mental model:

- `-peers` answers: "who do I know, and what is my best known way to reach them?"
- `-routes` answers: "what path will I actually take, including explicit route policy?"
- a one-off direct call usually yields:
  - caller sees `WAYS=out`
  - callee sees `WAYS=in`
- `-connect ... --ttl=0` upgrades the relationship to `WAYS=both` with state `connected`

Examples of the current UX:

- direct learn:
  - `./scripts/coord @A -whoami @127.0.0.1:4104`
  - `./scripts/coord @A -peers`
- reverse connect:
  - `./scripts/coord @A -connect @127.0.0.1:4104 --ttl=0`
  - `./scripts/coord @P -whoami @A`
- proxy through a reverse-connected proxy:
  - `./scripts/coord @D -learn @P`
  - `./scripts/coord @D -route:add @A @P`
  - `./scripts/coord @D -echo @A "hello from D" --verbose`
- learned reply path:
  - `./scripts/coord @A -route:deny @D out`
  - `./scripts/coord @A -whoami @D --verbose`

Implementation note:

- reverse connections are runtime-scoped today: `--ttl=0` means "keep it until disconnected or the daemon stops", not "survive daemon restart"

1) What cord is for
cord provides four big capabilities:
Connectivity & RPC: nodes can call methods on other nodes, optionally via a router relay.
Cluster management: define clusters, join/leave, membership, roles per cluster.
Leader election: one leader per shard per cluster, balancing by weight, leases/health.
IAM / Authorization: users, groups, permissions definitions, command registry, and enforcement—generic for any commands/apps.
Constraints you stated:
Connectivity is open; we enforce security at authorization layer.
New devices start as guest/unallocated.
First device easy; subsequent attachments require higher-level pairing logic (but cord must support it).
Web apps can’t discover nodes; only nodes (Android/Linux) may discover.
Nodes can belong to multiple clusters, with different roles in each.
Leaders are per shard with weight and should be balanced across eligible nodes.
Must work even if a node has no DB (persistence optional).

2) High-level cord layering
Think of cord as five modules:
cord_foundation: transport + RPC + basic identity (“whoami”, ping)
cord_cluster: clusters + membership + per-cluster roles/config
cord_election: shard leadership (leases, balancing)
cord_iam: users/groups/permissions/commands and authorization checks
cord_bootstrap: unallocated registration, claiming hooks, and default guest policy
These depend on each other in this order:
foundation → cluster → iam → election → bootstrap
(You can implement IAM before election if you want; election should enforce IAM on any privileged operations.)

3) Core data model (cord-level)
3.1 Node identity (machine)
A node has:
nodeId: stable (generated once per device)
nodeEpoch: changes on every process start (detect restarts)
addrs: addresses it can be reached at (optional)
props: extensible JSON (model/version/etc.)
type NodeInfo = {
 nodeId: string
 nodeEpoch: string
 addrs?: string[]           // ["10.0.0.23:33445"]
 props?: any                // {type:"FireTablet", model:"HD10", ...}
}
3.2 Cluster identity
A cluster is a named set of nodes with cluster-scoped configs:
type ClusterSpec = {
 clusterId: string
 name?: string
 props?: any
}
3.3 Cluster membership + per-cluster node role
A node can be in many clusters, and have different config in each.
type ClusterNodeConfig = {
 clusterId: string
 nodeId: string

 role: {
   proxyOnly?: boolean
   canSend?: boolean
   canReceive?: boolean
   eligibleLeader?: boolean
   // extensible:
   extra?: any
 }

 props?: any      // cluster-scoped props (e.g. "siteId", "rack", "region")
}
3.4 Shards and leadership
A shard is a logical unit of leadership within a cluster:
type ShardSpec = {
 shardId: string      // default: "default"
 weight?: number      // default: 1
 props?: any
}
Leadership assignment:
type LeaderAssignment = {
 clusterId: string
 shardId: string
 leaderNodeId: string
 term: number
 leaseUntilMs: number
}

4) Persistence strategy (cord must work with and without DB)
cord uses an optional store interface.
4.1 Store interface (generic KV)
interface CoordStore {
 get(key: string): Promise<any|null>
 set(key: string, value: any): Promise<void>
 del(key: string): Promise<void>
 list(prefix: string): Promise<{key: string, value: any}[]>
}
4.2 Store implementations
MemoryStore: default for ephemeral runs
FileJsonStore(path): for tablets/routers (persist between restarts)
StengStore(...): optional adapter that persists to steng later (not required now)
4.3 What gets persisted
cluster specs + membership configs
IAM users/groups/grants
shard specs + preferred placement (optional)
last-known leader assignments (cache)
bootstrapped guest defaults
Election leases should generally be volatile (in-memory) and derived from runtime behavior, not persisted.

5) cord_foundation: RPC and connectivity
5.1 Problem
You need a universal way for nodes to execute commands on other nodes, without baking in cluster logic. This is the substrate for everything else.
5.2 Solution
A lightweight RPC layer with:
handler registration by method name (string)
calls to NodeId or address
request/response envelopes with timeouts
optional relay later (router)
5.3 APIs
type RpcCtx = { auth?: any, srcNodeId?: string, traceId?: string }

interface FoundationNode {
 start(): Promise<void>
 stop(): Promise<void>
 self(): NodeInfo

 registerHandler(method: string, handler: (ctx: RpcCtx, params: any) => Promise<any>): void

 call<T>(target: {nodeId?: string, addr?: string}, method: string, params: any, opts?: {
   timeoutMs?: number
   traceId?: string
 }): Promise<T>

 ping(target: {nodeId?: string, addr?: string}): Promise<{ok: boolean, rttMs: number}>

 discover(opts?: { mode?: "udp"|"mdns"|"seeds", timeoutMs?: number }): Promise<NodeInfo[]>
}
5.4 Notes
discover() is optional: you can rely on a registrar rendezvous for peer lists.
Foundation does not decide “is this allowed”. That’s IAM.

6) cord_cluster: cluster management and membership
6.1 Problems
Nodes can be part of multiple clusters.
Need membership lists and per-cluster roles/config.
Need to execute commands across a cluster (fanout).
Need a way to “scan network and find nodes” (optional).
6.2 Solutions
Store cluster specs and membership in CoordStore.
Maintain an in-memory “alive view” via heartbeats.
Provide APIs to join/leave/list and exec across cluster.
Integrate discovery as a helper, not as a requirement.
6.3 Membership liveness
Use heartbeats:
each node sends cluster.heartbeat to a small peer set (or to a rendezvous) every H ms
alive if last seen within 3H
This is not consensus; it’s just liveness information.
6.4 APIs
interface ClusterManager {
 start(): Promise<void>
 stop(): Promise<void>

 createCluster(spec: ClusterSpec): Promise<void>
 dropCluster(clusterId: string): Promise<void>
 listClusters(): Promise<ClusterSpec[]>

 joinCluster(cfg: ClusterNodeConfig): Promise<void>
 leaveCluster(clusterId: string): Promise<void>

 listNodes(clusterId: string): Promise<ClusterNodeConfig[]>
 getNode(clusterId: string, nodeId: string): Promise<ClusterNodeConfig|null>

 // Liveness view
 getAliveNodes(clusterId: string): Promise<{nodeId: string, lastSeenMs: number}[]>

 // Fanout exec (uses foundation.call underneath)
 execOnCluster(clusterId: string, method: string, params: any, opts?: {
   parallel?: number
   timeoutMs?: number
   bestEffort?: boolean
 }): Promise<{nodeId: string, ok: boolean, result?: any, err?: string}[]>

 // Optional discovery helper
 discoverAndSuggest(clusterId: string): Promise<NodeInfo[]>
}
6.5 Key rule
Cluster membership alone does not grant permissions. IAM controls what a caller can do.

7) cord_iam: groups, permissions, users, commands
cord_iam is generic and doesn’t know “POS” or “netab”. It only knows opaque strings.
7.1 Problems
Need default guest with minimal abilities.
Need groups that can include groups and arbitrary items.
Need a permission catalog to describe meaning (for UI/auditing).
Need command manager: list of commands and who can run them, with masks.
Need to protect against guest DDOS (limit expensive commands).
7.2 Solutions
Maintain:
Group graph (DAG) of membership
User registry and credentials
Command registry
Grants from subjects (users/groups) to commands with optional mask/scope
Enforce on every RPC: authorize(ctx, commandId, mask, scope).
7.3 Namespacing
Everything lives in a namespace string (tenant/app/cluster). Example:
ns = "tenant:abc"
ns = "tenant:abc:pos"
ns = "cluster:offline:Miami1"
You can start with a single namespace per deployment.

7.4 Group manager
Groups can contain:
users (user:123)
nodes (node:abc)
commands (cmd:cord.exec)
other groups (grp:...)
arbitrary items
APIs:
interface GroupManager {
 createGroup(ns: string, groupId: string, meta?: any): Promise<void>
 deleteGroup(ns: string, groupId: string): Promise<void>

 addMember(ns: string, groupId: string, itemRef: string): Promise<void>
 removeMember(ns: string, groupId: string, itemRef: string): Promise<void>

 addSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void>
 removeSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void>

 listMembers(ns: string, groupId: string, opts?: {recursive?: boolean}): Promise<string[]>
 isMember(ns: string, groupId: string, itemRef: string, opts?: {recursive?: boolean}): Promise<boolean>
}
Cycle prevention is required for subgroup links.

7.5 Permission catalog (descriptive)
APIs:
interface PermissionCatalog {
 definePermission(ns: string, permId: string, def: {
   title: string
   description: string
   maskBits?: Record<string, number>
   scopeType?: string
 }): Promise<void>

 getPermission(ns: string, permId: string): Promise<any|null>
 listPermissions(ns: string, prefix?: string): Promise<any[]>
}
This is optional in v1 but helps a lot for later UIs.

7.6 User manager
APIs:
interface UserManager {
 ensureGuest(ns: string): Promise<string> // returns userId "user:guest"
 createUser(ns: string, user: {userId: string, displayName?: string, props?: any}): Promise<void>
 getUser(ns: string, userId: string): Promise<any|null>

 setCredential(ns: string, userId: string, cred: {type:"pin"|"password"|"none", secretHash?: string}): Promise<void>
 verifyCredential(ns: string, userId: string, proof: any): Promise<boolean>

 addUserToGroup(ns: string, userId: string, groupId: string): Promise<void>
 removeUserFromGroup(ns: string, userId: string, groupId: string): Promise<void>
}

7.7 Command manager (authorization engine)
Commands are identified by strings (namespaced).
 Grant rules allow/deny, optional mask, optional scope constraints.
APIs:
interface CommandManager {
 defineCommand(ns: string, commandId: string, def: {
   title: string
   description: string
   maskBits?: Record<string, number>
   scopeType?: string
 }): Promise<void>

 grant(ns: string, subject: string /* user:* or grp:* */, commandId: string, grant: {
   allow: boolean
   mask?: number
   scope?: any
 }): Promise<void>

 revoke(ns: string, subject: string, commandId: string): Promise<void>

 canInvoke(ns: string, ctx: {
   userId: string
   groups: string[]
   scope?: any
 }, commandId: string, requestedMask?: number): Promise<boolean>
}
7.8 Guest DDOS mitigation
Even with connectivity open, cord must:
enforce that guest can only invoke a tiny allowlist of cheap commands
rate-limit at RPC layer (per IP/nodeId)
cap payload sizes
Example “guest allowed command set”:
cmd:cord.foundation.ping
cmd:cord.foundation.whoami
cmd:cord.cluster.heartbeat
cmd:cord.bootstrap.register_unallocated
No cluster exec, no list-all-nodes unless authorized.

8) cord_election: leaders per shard with weight balancing
8.1 Problems
Need one leader per shard.
Leaders should be balanced across eligible nodes by shard weights.
Node eligibility differs by cluster.
Must handle failures and re-election.
Must not depend on Postgres locks or any DB.
8.2 Solution overview
Use:
membership liveness from cord_cluster
a lease protocol using RPC between nodes (2/3 quorum or strict all)
a balancing algorithm to choose preferred leader per shard
The election manager runs on every node, but only eligible nodes attempt to acquire leases.
8.3 Shard balancing algorithm (v1)
Goal: minimize max load per node.
Maintain a current assignment map:
nodeLoad[node] = sum(weights of shards it leads)
When assigning a shard:
pick eligible node with lowest nodeLoad
tie-break by node priority and nodeId
Stability rule:
keep current leader if healthy and eligible (avoid churn)
8.4 Lease protocol options
Quorum 2/3: good availability if one node down
Strict all: leader must be reachable by all; safer but less available
Given your “VPS can go down; system should continue”, quorum is generally better online.
8.5 APIs
interface ElectionManager {
 start(): Promise<void>
 stop(): Promise<void>

 addShard(clusterId: string, shard: {shardId: string, weight?: number}): Promise<void>
 removeShard(clusterId: string, shardId: string): Promise<void>
 listShards(clusterId: string): Promise<any[]>

 getLeader(clusterId: string, shardId: string): Promise<LeaderAssignment|null>
 listLeaders(clusterId: string): Promise<LeaderAssignment[]>

 onLeaderChange(cb: (ev: {clusterId: string, shardId: string, from?: string, to: string}) => void): () => void

 // optional admin tools
 forceLeader(clusterId: string, shardId: string, nodeId: string, ttlMs?: number): Promise<void>
}
8.6 Internal RPC methods (election)
These are invoked node-to-node:
cord.election.RequestLease(clusterId, shardId, term, ttlMs)
cord.election.RenewLease(clusterId, shardId, term, ttlMs)
cord.election.ReleaseLease(clusterId, shardId, term)
All must be authorized:
only nodes with eligibleLeader role can request
only current leader can renew
only admin can force

9) cord_bootstrap: unallocated registration and claiming hooks
9.1 Problems
First tablet easy.
New tablets should not auto-join a real location cluster.
Must support later pairing/claim flows.
Web apps cannot discover nodes.
9.2 Solution
On startup, nodes register into a special state:
clusterId = "unallocated" (or conceptually “unallocated pool”)
role = guest
only minimal commands allowed
Bootstrap provides:
register_unallocated(nodeInfo)
heartbeat_unallocated(nodeId)
list_unallocated() (admin only)
claim() (admin only; higher-level app drives it)
This keeps cord neutral while enabling POS pairing later.
9.3 APIs
interface BootstrapManager {
 registerUnallocated(nodeInfo: NodeInfo): Promise<{status:"unallocated"}>

 // later:
 listUnallocated(ns: string): Promise<NodeInfo[]>            // admin only
 claimNode(ns: string, nodeId: string, proof: any): Promise<void> // admin only
}

10) How it all executes: request lifecycle & enforcement
10.1 RPC request flow
foundation receives an RPC call: {method, params, auth}
IAM maps method -> commandId (usually same string)
command manager checks canInvoke(...) using user groups
if allowed, dispatch handler
handler may call cluster manager, election manager, etc.
10.2 Node vs user context
Requests can come from:
user (web/admin UI) → user token
node-to-node internal calls → node token (or a special internal group)
IAM doesn’t care; it evaluates the presented identity and groups.

11) Common pitfalls and how cord design addresses them
Pitfall A: unauthorized tablet joins location cluster
Solution:
unallocated by default
attaching to a real cluster requires privileged command (admin/installer)
higher-level app can implement pairing approvals
Pitfall B: guest DDOS / expensive operations
Solution:
guest can only run cheap commands
hard rate limits and payload caps in foundation RPC
cluster-wide list/exec requires privilege
Pitfall C: leader election churn
Solution:
lease TTL + renew schedule
stability rule: keep leader if healthy
balancing only reassigns when needed or on config changes
Pitfall D: multiple clusters per node
Solution:
cluster-scoped config objects
membership is keyed by (clusterId,nodeId)
roles and eligibility are per cluster
Pitfall E: persistence dependency
Solution:
CoordStore interface with file/memory
election leases remain runtime-state

12) Implementation sequence (practical)
Here’s a good order to implement cord:
foundation RPC: call/registerHandler/ping + payload limits
CoordStore: memory + file
cluster manager: create/join/list + heartbeat liveness
IAM: guest user + command registry + allowlist + enforcement
bootstrap: registerUnallocated + list for admin
election: shards + balancing + lease RPC + getLeader()
You can test each step with a simple playground.

13) cord playground scenarios (how you validate behavior)
Scenario 1: Guest startup safety
Start 3 nodes
Each registers unallocated
From guest context:
ping works
listClusters denied
execOnCluster denied
Scenario 2: Admin creates a cluster and attaches nodes
Admin creates cluster offline:Miami1
Admin moves node A/B/C from unallocated to this cluster
Nodes heartbeat; listNodes shows 3 nodes
Scenario 3: Election per shard
Create shards: Miami1, Miami2, Miami3 with weights
Verify leaders distribute across nodes
Kill leader; re-election
Scenario 4: Multi-cluster membership
Node A joins offline:Miami1 and online (different roles)
Confirm IAM rules differ per cluster namespace (if you choose)

14) Concrete API checklist (cord public surface)
At minimum, cord should expose these method names (as commands):
Foundation
cord.foundation.ping
cord.foundation.whoami
Cluster
cord.cluster.create
cord.cluster.join
cord.cluster.leave
cord.cluster.listNodes
cord.cluster.execOnCluster (privileged)
IAM
cord.iam.defineCommand
cord.iam.grant
cord.iam.canInvoke
cord.users.ensureGuest
Bootstrap
cord.bootstrap.registerUnallocated
cord.bootstrap.listUnallocated (privileged)
Election
cord.election.addShard
cord.election.getLeader
cord.election.RequestLease (internal)
cord.election.RenewLease (internal)

. Chapter: coord_cli — CLI Converter and Command Dispatch Core
This chapter defines a reusable CLI component for coord that parses your ergonomic command format into a structured invocation and dispatches it to registered handlers. The goal is that cord_foundation / cord_cluster / cord_election / cord_iam / netab / app_helpers can all share the same CLI parsing, help, file/stdin handling, coercion, formatting, and error conventions.
coord_cli is not a networking layer and contains no business logic. It is a small “front-end runtime” for CLI tools.

1) Why coord_cli exists
Without coord_cli, each subsystem ends up reimplementing:
argument parsing
@file / @- stdin handling
type coercion ("123" -> 123)
command grouping (group:cmd)
global options (--timeout, --json, --parallel)
consistent error messages + exit codes
help/usage output
This becomes a maintenance nightmare. With coord_cli:
New commands become “register a handler + help string”.
Playgrounds are easy: coord ... is the universal tool.

2) CLI grammar supported
You defined two forms; coord_cli must support both exactly:
2.1 Base commands (local)
coord -[base_cmd] [...cmd_params...]
Examples:
coord -start:4001 A config.js
coord -discover 4001,4002 600
coord -save coord.config.js
coord -load coord.config.js
2.2 Targeted commands (remote or fanout)
coord [node_name|node_ip[:port]|#cluster_name] [--param1 [--param2 ...]] [cmd_group_name:]cmd_name [...cmd_params...]
Examples:
coord B -ping 5
coord 10.0.0.12:4001 whoami
coord #offlineMiami1 --parallel=10 echo "hi"
coord B bad_group:echo 123
Notes:
If group is omitted, default group is foundation.
#cluster_name targets cluster fanout (handled by higher layer; coord_cli just parses).

3) Outputs of parsing: the Invocation object
coord_cli converts raw argv into a structured invocation.
type Target =
 | { kind: "none" }                 // base command
 | { kind: "node", value: string }  // node_name
 | { kind: "addr", value: string }  // ip[:port]
 | { kind: "cluster", value: string } // "#cluster"

type Invocation = {
 raw: string[]                       // original argv tokens (excluding "coord")
 kind: "base" | "targeted"

 baseCmd?: string                    // e.g. "start", "discover", "save", "load"
 baseCmdPort?: number | null         // for -start:4001 pattern
 baseArgs?: string[]                 // base command params (positional)

 target: Target                      // for targeted invocations

 // Global options from --param... before cmd token
 options: {
   timeoutMs?: number
   json?: boolean
   pretty?: boolean
   trace?: string
   parallel?: number
   bestEffort?: boolean
   auth?: string
   [k: string]: any
 }

 // Command identity
 group: string                       // default "foundation"
 cmd: string                         // command name
 fullCmd: string                     // `${group}:${cmd}`

 // Command params (built from key=value, args, and @file/@-)
 params: Record<string, any>

 // Positional args that weren't key=value or files
 args: any[]

 // Optional payload (if @file/@- used in a position reserved for payload)
 payload?: {
   kind: "bytes" | "json"
   name: string                      // filename or "-"
   bytes?: Uint8Array
   json?: any
 }
}
This object is the universal “call contract” for all CLI handlers.

4) Parsing rules (unambiguous)
4.1 Identify base vs targeted
If first token starts with - → base command
Else → targeted command
4.2 Base command parsing
Token form: -start:4001 or -start
-<name> parses baseCmd = <name>
optional :<port> parses baseCmdPort
remaining tokens are baseArgs
Examples:
-start:4001 A config.js
baseCmd=start, baseCmdPort=4001, baseArgs=["A","config.js"]
-discover 4001,4102 600
baseCmd=discover, baseArgs=["4001,4102","600"]
4.3 Target parsing
First token (target) can be:
#clusterName → {kind:"cluster"}
contains : and looks like ip:port → {kind:"addr"}
otherwise treat as {kind:"node"} (name)
(Exact IP detection can be best-effort; if ambiguous, allow explicit --addr= later.)
4.4 Global --options parsing
After target token, parse any number of --... tokens until the first non--- token.
Supported forms:
--timeout=200
--timeout 200
boolean flags: --json, --pretty, --bestEffort
numbers auto-coerced
These fill inv.options.
4.5 Command token parsing (group:cmd)
Next token is the command token:
If it contains exactly one : → group and cmd
Else group="foundation" and cmd=token
Examples:
echo → foundation:echo
cluster:nodes → cluster:nodes
4.6 Command parameter parsing (cmd_params)
Remaining tokens become params. Three kinds:
A) key=value
ms=2000 → {ms: 2000}
type coercion applies to value
B) positional args
tokens not matching key=value and not file tokens become args[]
C) file/stdin tokens
@file → load bytes as payload (or treat as arg, depending on command)
@file.json → parse JSON as payload
@- → read stdin as bytes
Rule for payload vs arg:
 coord_cli does not decide semantics; it provides both:
it adds the loaded content to payload (last seen file token)
it also records the original token in args unless handler declares it consumes payload
To keep it simple, recommend a convention:
if any token begins with @, coord_cli sets payload and does not include that token in args
handler reads inv.payload when it wants raw bytes/json
That yields predictable UX.
4.7 Type coercion
For key=value and positional args:
true/false/null → boolean/null
integer → number
float → number
otherwise string

5) Dispatch model
coord_cli includes a registry and dispatcher.
5.1 Registry
Commands are registered by full name:
Base commands: "base:start", "base:discover", etc.
Group commands: "foundation:whoami", "cluster:nodes", etc.
type Handler = (inv: Invocation, ctx: any) => Promise<any>

interface CommandRegistry {
 registerBase(name: string, handler: Handler, help?: HelpSpec): void
 registerCmd(fullCmd: string, handler: Handler, help?: HelpSpec): void
 hasBase(name: string): boolean
 hasCmd(fullCmd: string): boolean
 helpFor(nameOrCmd: string): HelpSpec | null
}
5.2 Dispatcher
Dispatcher:
parses argv → Invocation
selects handler
executes handler
prints output (pretty or JSON)
returns exit code
interface Dispatcher {
 run(argv: string[], ctx: any): Promise<number>
}

6) Standard errors + exit codes
Make errors uniform so playbooks and scripts are reliable:
Case
Exit Code
Example
Unknown base command
2
coord -bad
Unknown group
3
coord B bad_group:echo
Unknown cmd
4
coord B bad_cmd
Parse error
5
malformed --timeout=
RPC timeout
6
--timeout=200 sleep ms=2000
RPC transport error
7
connection refused
Remote method error
8
remote returned METHOD_NOT_FOUND
Permission denied
9
(later) authz fail

Error message guidelines:
one-line summary
one-line hint (suggest closest command) when possible
Examples:
ERROR unknown command group "bad_group" (did you mean "foundation"?)
ERROR unknown command "foundation:bad_cmd" (try "coord B whoami")

7) Help generation (critical for usability)
Every registered command can provide a small help spec:
type HelpSpec = {
 summary: string
 usage: string[]          // e.g. ["coord B echo <text|@file|@->", ...]
 options?: string[]       // global options relevant to this command
 examples?: string[]
}
Commands:
coord -help lists major commands and groups
coord -help foundation lists foundation commands
coord -help foundation:echo shows full help

8) Integration points (how other components use it)
Each subsystem exports a “CLI plugin” that registers commands.
Example pattern:
cord_foundation/cli_plugin.ts
cord_cluster/cli_plugin.ts
cord_iam/cli_plugin.ts
cord_election/cli_plugin.ts
Each plugin has:
export function register(reg: CommandRegistry, ctx: any): void
So coord main wires:
create registry
register plugins
dispatcher.run(argv, ctx)
This lets you ship one binary coord with all capabilities, or separate builds.

9) Example: foundation plugin mapping
foundation:whoami → remote RPC foundation.whoami call
foundation:echo → remote RPC foundation.echo call
foundation:sleep → remote RPC foundation.sleep call
client-side ping can be implemented as a special handler that loops whoami and measures RTT.
The CLI handler for whoami should:
resolve target name → addr using cache (from -discover), else accept direct addr
call RPC
print pretty JSON by default

10) Example invocation parsing (your examples)
coord B echo "test works"
target: node “B”
options: none
group/cmd: foundation:echo
params: { args: ["test works"] }
coord 10.0.0.12:4001 whoami
target: addr “10.0.0.12:4001”
group/cmd: foundation:whoami
coord B bad_group:echo 123
group “bad_group” not registered → exit code 3
coord B bad_cmd
cmd “foundation:bad_cmd” not registered → exit code 4

11) Recommended minimum base commands registered by core
base:start (daemon)
base:discover (scan + cache)
base:save (save cache/config)
base:load (load cache/config)
base:help
Everything else is a plugin.

12) “Playground feel” checklist
When coord_cli is right, you should feel:
you can type coord -start and it starts
you can type coord -discover and names become usable
you can type coord B whoami with no flags
you can pass structured params without JSON (ms=2000)
@file and @- work naturally
errors are short and helpful
coord -help is actually useful


coord foundation playground design doc
This is a hands-on CLI playground for validating cord_foundation (transport + RPC) with the exact coord command format you specified.
The goal: you can run a few nodes locally (or on tablets/VPS) and quickly convince yourself that:
nodes start with near-zero config
RPC works (whoami/echo)
errors are handled cleanly (bad group/cmd)
file/stdin payloads work
timeouts and rate limits behave
discovery caches node names for later use

1) Scope
This playground tests foundation only:
✅ Included
starting a node (coord -start)
discovery caching (coord -discover)
direct node targeting by name or ip:port
built-in commands: whoami, echo, sleep
client-side ping
error UX for unknown group/cmd
payload modes: strings, key=value, @file, @-
optional global params: --timeout, --json, --parallel (parallel only meaningful for cluster target later)
❌ Not included (future playgrounds)
clusters (#cluster targets)
leader election
IAM / authorization enforcement (for now, foundation permits all)
proxy/router

2) Folder layout (recommended)
playground/cord_foundation/
 README.md
 configs/
   A.js
   B.js
   C.js
 scripts/
   run_3_nodes.sh
   stop_all.sh
   clean_cache.sh
 data/
   coord.cache.json          # written by -discover / -save
 samples/
   bigfile.txt
   bigfile.bin

3) Built-in foundation commands
These must exist on every foundation node started by coord -start.
3.1 whoami
Returns node identity.
CLI:
coord B whoami
coord 127.0.0.1:4102 whoami
coord 10.0.0.13:4001 whoami
Response (pretty default):
{
 "nodeId": "B",
 "nodeEpoch": "91aa...",
 "listen": "127.0.0.1:4102",
 "props": { "type": "dev" }
}
3.2 echo
Echoes arguments and supports file/stdin payloads.
CLI examples:
coord B echo "test works"
coord B echo @playground/cord_foundation/samples/bigfile.txt
cat playground/cord_foundation/samples/bigfile.txt | coord B echo @-
Echo semantics
if args are provided: return args array and/or joined text
if @file or @- used: return payload length + first bytes preview (don’t print huge output by default)
Recommended output shape:
{ "ok": true, "bytes": 1048576, "sha256": "...", "preview": "..." }
3.3 sleep
Sleeps for ms (used to test timeouts).
CLI:
coord B sleep ms=2000
coord B --timeout=200 sleep ms=2000
Expected behavior:
without timeout: returns after ~2s with {sleptMs:2000}
with timeout: CLI reports TIMEOUT and exits nonzero

4) CLI grammar (as implemented in playground)
4.1 Base commands
coord -[base_cmd] [...cmd_params...]
Used in foundation playground:
-start[:port] [node_name] [config.js]
-discover [port1[,port2...]] [ttl_in_secs]
-save [config.js]
-load [config.js]
4.2 Targeted commands
coord [node_name|node_ip[:port]|#cluster_name] [--param1 [--param2 ...]] [cmd_group:]cmd [...cmd_params...]
Foundation playground uses:
node_name resolved from discovery cache
node_ip[:port] direct
#cluster not used yet (reserved)

5) Global CLI options (--param...)
These modify execution, not command params.
Minimum set for foundation playground:
--timeout=MS (default 5000)
--json (print raw JSON)
--pretty (default; colorized, human friendly)
--verbose (show routing/debug metadata)
--dst=NODE (ask the contacted node to execute on another node)
--trace=ID (optional; otherwise auto)
--quiet (only exit code matters)
Examples:
coord B --timeout=200 whoami
coord A --dst=D whoami
coord B --json whoami

6) Parameter passing rules (usability-first)
6.1 key=value
coord B sleep ms=2000
Parsed params object:
{ ms: 2000 }
6.2 positional args
coord B echo hello world
Parsed params object:
{ args: ["hello","world"] }
6.3 file/stdin
@path → bytes
@path.json → parse JSON and pass object
@- → stdin bytes
Examples:
coord B echo @bigfile.txt
coord B cmd:apply @settings.json
cat bigfile.bin | coord B echo @-
6.4 coercion
123 → number
true/false/null → boolean/null
everything else string

7) Discovery design (foundation playground)
Command
coord -discover [ports] [ttl]
Behavior
Scans local subnet (or dev mode loopback) and finds nodes responding to whoami.
Stores a cache mapping:
nodeId/name → addr, epoch, lastSeen
TTL means: treat cache entries older than TTL as expired and don’t use them.
Output
Found 3 nodes (ttl 600s)
NAME  ADDR             AGE  EPOCH
A     127.0.0.1:4101   0s   ...
B     127.0.0.1:4102   0s   ...
C     127.0.0.1:4103   0s   ...
Cache file
Default: ./playground/cord_foundation/data/coord.cache.json (or cwd coord.cache.json)

8) Node start behavior
Command
coord -start[:port] [node_name] [config.js]
Defaults
port default: 4001
name default: auto-generated node-XXXX
bind default: 0.0.0.0
props default: {type:"dev"}
request limits default:
maxRequestBytes: 64KB
maxRps per source: 20
What gets printed
Single line for copy/paste:
Started node B at 127.0.0.1:4102 (epoch 91aa...) [foundation]

9) Test plan (step-by-step)
Test 0 — bring up 3 nodes
coord -start:4101 A
coord -start:4102 B
coord -start:4103 C
✅ Expected: 3 “Started node …” lines.

Test 1 — discover them
coord -discover 4101,4102,4103 600
✅ Expected: printed table with A/B/C, cache saved.

Test 2 — direct RPC by node name
coord A whoami
coord B echo "test works"
coord C sleep ms=100
✅ Expected:
whoami returns A identity
echo returns confirmation
sleep returns {sleptMs:100}

Test 3 — direct RPC by ip:port
coord 127.0.0.1:4102 whoami
✅ Expected: identity for B.

Test 4 — timeout behavior
coord B --timeout=200 sleep ms=2000
✅ Expected:
CLI prints TIMEOUT (or structured error)
exit code nonzero

Test 5 — file payload
coord B echo @playground/cord_foundation/samples/bigfile.txt
✅ Expected:
response shows byte count and hash
node does not print full file

Test 6 — stdin payload
cat playground/cord_foundation/samples/bigfile.txt | coord B echo @-
✅ Expected: same as file payload.

Test 7 — bad group / bad cmd UX
coord B bad_group:echo 123
coord B bad_cmd
✅ Expected:
clear error messages:
unknown command group
unknown command
exit code nonzero

Test 8 — restart and epoch changes
Stop B and restart:
# Ctrl+C in B terminal, then:
coord -start:4102 B
coord -discover 4101,4102,4103 600
coord B whoami
✅ Expected:
same nodeId “B”
different nodeEpoch
cache updates

10) Transport protocol (implementation notes)
Foundation playground assumes a simple HTTP JSON RPC:
POST /rpc
request:
{
 "method": "foundation.whoami",
 "params": { ... },
 "traceId": "auto",
 "auth": null
}
response:
{ "ok": true, "result": {...} }
or
{ "ok": false, "error": { "code":"METHOD_NOT_FOUND", "message":"..." } }
CLI never requires users to write JSON; it assembles this internally.

11) Logging (so you trust it)
Each node should log 1 line per request:
ts=... src=... method=foundation.echo trace=... ms=3 ok bytesIn=... bytesOut=...
This makes it easy to correlate CLI actions with server behavior.

12) Success criteria
You should feel confident in foundation when:
starting nodes is trivial
discovery reliably caches names
calling by name “just works”
timeouts are predictable
errors are readable and actionable
file/stdin payloads work without surprises
restart changes epoch and doesn’t break cache logic


Foundation Routing & Proxy Playground
0) What we assume exists

You can start nodes:

coord -start:4101 A
coord -start:4102 B
coord -start:4103 C
coord -start:4104 P
coord -start:4105 D

You can discover and refer to nodes by name:

coord -discover 4101,4102,4103,4104,4105 600
Built-in commands work:
whoami
echo
ping (client-side loop or command)
1) Mental model
Route table is per node

coord A route ... modifies/prints A’s local routing policy.

There are three independent mechanisms
Direct calls: A can talk to B directly (if not denied).
Deny rules: simulate broken/unidirectional connectivity.
Proxy routes: A can reach D via proxy P using route add D P.
--dst is universal
Without --dst, you execute on the node you contact:
coord A whoami runs on A.
With --dst=X, you ask A to execute on X:
coord A --dst=D whoami runs on D via A’s routing.
Proxy mode is optional convenience

If proxy mode is ON, coord A <cmd> can auto-forward to a default destination when --dst is absent.

2) Command reference (routing-related)
2.1 Print routes
coord A route print

Output encodes for each destination:

direct full: A -> B
inbound only: C{in}
outbound only: C{out}
proxy used: D[P]
disabled: X{none}

Also show:

deny list
proxy mode state
TTL for learned reachability (if any)
2.2 Add route
coord A route add B
coord A route add D P

Meaning:

route add B = “A knows B exists; prefer direct”
route add D P = “A reaches D via proxy P (single hop)”
2.3 Deny connectivity (simulate one-way)
coord A route deny out B
coord A route deny in  B
coord A route deny B         # deny both in and out

Rules:

deny out B: A will not attempt direct outgoing to B.
deny in B: A will reject inbound calls from B.
Deny does not block proxy connectivity unless the proxy itself is blocked.
2.4 Delete route record
coord A route del B

Removes the explicit route entry for B from A’s route table.
(Does not automatically remove deny rules unless you choose to tie them together.)

2.5 Proxy mode
coord A proxy on D
coord A proxy off

When ON:

If --dst is absent, destination defaults to D.
If --dst is present, it overrides default.
3) Playground Scenario 1: Baseline direct connectivity
Step 1: Start nodes and discover
coord -start:4101 A
coord -start:4102 B
coord -start:4103 C
coord -start:4104 P
coord -start:4105 D
coord -discover 4101,4102,4103,4104,4105 600
Step 2: Confirm direct RPC works
coord A whoami
coord B echo "hello"
coord C echo "ok"
coord D whoami
Step 3: Print routes (initial)
coord A route print

Expected (example): since no explicit routes yet, you might show only discovered nodes as direct candidates:

B, C, P, D all appear as A -> X if you treat discovery as “direct allowed”.

If you prefer, discovery can populate route entries automatically with TTL.

4) Playground Scenario 2: Simulate one-way connectivity

Goal: create a situation where A cannot call C, but C can call A.

Step 1: Deny outbound from A to C
coord A route deny out C
Step 2: Validate behavior
This should fail (A trying to execute on C via --dst=C requires A->C outbound):
coord A --dst=C whoami

Expected:

ERROR route denied: out to C (no proxy route)
This should still work (C calls A directly):
coord C --dst=A echo "can you hear me?"

Expected:

A receives and executes echo on itself? Careful: coord C --dst=A echo ... means “execute echo on A via C”.
So it requires C->A outbound, which is allowed.
A returns result.
Step 3: route print should show inbound-only hint

Now A has observed inbound from C (because C called A). So:

coord A route print

Expected:

C{in} or C{in} + deny(out) depending on how you want to annotate.
Recommended: show both:
C   C{in}  deny(out)

Implementation detail:

mark in as true for C when A receives any request with src=C
apply TTL (e.g., 300s) so it expires if C disappears
5) Playground Scenario 3: Proxy routing (single hop)

Now simulate your topology:

A/B/C cannot reach D directly
they can reach proxy P
P can reach D
and P may not be able to dial back into A/B/C (but they can still call P)

We’ll model it with deny rules + proxy routes.

Step 1: Ensure P is acting as proxy (optional)
coord P proxy on

(Proxy mode on P is not strictly required if routing is done by --dst forwarding, but it’s a good test.)

Step 2: Block direct A->D
coord A route deny out D
Step 3: Define route A->D via P
coord A route add D P
Step 4: Verify routed execution works
coord A --dst=D whoami
coord A --dst=D echo "hello D"

Expected:

Success, and route path shown in verbose mode (optional):
OK via proxy P -> D
Step 5: Verify D->A also works via P (hard case)

If D cannot reach A directly, deny:

coord D route deny out A
coord D route add A P

Now:

coord D --dst=A echo "hello A from D"

Expected: success via P.

Step 6: Inspect route tables
coord A route print
coord D route print
coord P route print

Expected:

A shows D[P] and deny(out) D
D shows A[P] and deny(out) A
P shows normal direct to D, and may show inbound-only for A if P can’t dial A
6) Playground Scenario 4: Proxy mode convenience (default dst)

This tests the “operator ergonomics” of proxy mode.

Step 1: Set A proxy default to D
coord A proxy on D
Step 2: Now commands without --dst go to D
coord A whoami
coord A echo "goes to D"

This should execute on D (via A’s routing logic).
To execute on A itself while proxy mode is on, you must explicitly override:

coord A --dst=A whoami
Step 3: Turn off
coord A proxy off
7) Failure-mode tests (you should run these)
7.1 Proxy unreachable

Block A->P:

coord A route deny out P
coord A --dst=D whoami

Expected:

ERROR cannot reach proxy P (route denied or unreachable)
7.2 No route and direct denied
coord A route deny out D
coord A route del D
coord A --dst=D whoami

Expected:

ERROR no route to D (direct denied, no proxy route)
7.3 Loop prevention (optional)

If someone misconfigures:

A routes D via P
P routes D via A
Single hop constraint should reject:
ERROR invalid route: proxy hop exceeds 1
8) Recommended debug output knobs (CLI)

To make you confident, add:

--verbose on CLI to show routing decisions:
chosen next hop
deny reason
whether proxy is used
route print --verbose to show:
lastSeen timestamps
TTL remaining
whether in/out is observed vs configured

Example:

coord A --verbose --dst=D whoami
coord A route print --verbose
9) Implementation notes (so this doesn’t get messy later)
9.1 Separate “policy” vs “observation”
Policy: explicit route add, route deny
Observation: inferred in/out reachability from probes and incoming traffic
route print combines both, with TTL on observation
9.2 --dst should be uniform across all command groups

Even later for cluster:* or election:*, --dst should still mean:

send the command to A, and A executes it on dst (possibly via proxy)

This keeps UX consistent.

9.3 One proxy hop invariant

Enforce at runtime:

if A has route to D via P, then A forwards once to P, and P must deliver directly to D.
No nested proxy forwarding.

10) 2026 CLI and connectivity addendum

The implementation in this repo now goes beyond the older target-first examples above.

The current operator-facing syntax is:

coord [@sender] -command [@target|%cluster] [args...] [--options...]

10.1 Selector meanings

@A
node selector by learned node id / name

@157.250.198.83:4104
direct node selector by address

%offline
cluster selector

@./payload.json
file payload shortcut

f:./payload.json
explicit file payload syntax

10.2 Sender selection

If exactly one local daemon exists under the current `COORD_PLAYGROUND_ROOT`, sender selection is implicit.

Examples:

./scripts/coord -whoami
./scripts/coord -peers

If multiple local daemons exist, sender must be explicit:

./scripts/coord @A -peers
./scripts/coord @D -echo @A "hello"

10.3 Automatic peer learning

Any successful RPC now updates peer knowledge on both sides.

Direct call example:

./scripts/coord @A -whoami @127.0.0.1:4104

Effects:

- A learns peer `P` with `VIA=127.0.0.1:4104`, `WAYS=out`
- P learns peer `A` with `VIA=127.0.0.1:4101`, `WAYS=in`

This is intentionally asymmetric. A one-off response to an outbound HTTP request does not imply a durable reverse path.

10.4 Reverse connections

`-connect` creates a long-lived reverse session from the sender into the selected direct peer.

Example:

./scripts/coord @A -connect @157.250.198.83:4104 --ttl=0

Effects:

- A keeps polling P
- P can enqueue RPC work back to A
- peer state becomes `STATE=connected`
- A sees `VIA=<direct addr>`
- P sees `VIA=reverse`

`--ttl=0` currently means "keep it until disconnected or until the daemon stops". It is not yet persisted across daemon restarts.

10.5 `-peers` semantics

`-peers` shows the best currently known path to each peer.

Columns:

- `VIA`
  - direct address for direct reachability
  - `via P` for proxy reachability
  - `reverse` when the peer opened a reverse session into this node
- `WAYS`
  - `out`: this node has recently sent to that peer
  - `in`: that peer has recently reached this node
  - `both`: both directions are established, usually via `-connect`
  - `-`: imported suggestion that has not been verified yet
- `STATE`
  - `learned`
  - `suggested`
  - `connected`

10.6 `-routes` semantics

`-routes` answers a different question than `-peers`.

- `-peers` = identity plus best known peer path
- `-routes` = effective routing decision, including explicit `-route:add`, deny rules, and the rendered path

Examples of rendered paths:

- `A -> B`
- `A -> P -> D`
- `D -> P -< A`

The `-<` notation means the last hop uses a reverse connection opened by the destination side.

10.7 Suggested peers vs learned peers

`-learn @P` imports peer knowledge from `P`, but imported peers stay in `STATE=suggested` until used successfully.

Example:

./scripts/coord @D -learn @P
./scripts/coord @D -peers

Typical result:

A via P appears as:

- `VIA=via P`
- `WAYS=-`
- `STATE=suggested`

After:

./scripts/coord @D -route:add @A @P
./scripts/coord @D -echo @A "hello from D" --verbose

the route is verified and the CLI prints:

D -> P -< A

10.8 Learned reply paths

When `D` reaches `A` through proxy `P`, `A` learns that `D` exists via `P`.

This is important for real topologies where:

- `A` can reach public proxy `P`
- `D` is only reachable from `P`
- `A` still needs to reply to `D`

To force the reply to use the learned proxy path instead of any direct local shortcut, deny direct outbound first:

./scripts/coord @A -route:deny @D out
./scripts/coord @A -whoami @D --verbose

Expected route shape:

A -> P -> D

10.9 Current operator flow for the home/VPS topology

Home node:

./scripts/coord -start:4102 home
./scripts/coord -connect @debian13.ispot.cc:4104 --ttl=0
./scripts/coord -peers

VPS proxy:

./scripts/coord -start:4104 P
./scripts/coord @P -peers

VPS worker:

./scripts/coord -start:4105 D
./scripts/coord @D -learn @P
./scripts/coord @D -route:add @home @P
./scripts/coord @D -echo @home "hello from D" --verbose

This produces the mixed path:

D -> P -< home

and after that `home` can reply back through `P` even if `D` is not directly dialable from home.
