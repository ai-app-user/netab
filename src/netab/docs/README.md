# netab

`netab` is the authenticated, cluster-aware network tables layer.

Public surface:

- `NetabService`: user-facing API implementation
- `NetabDirectory`: cluster/service lookup
- `createNetabClient`: local or HTTP client
- `startNetabHttpServer`: Node HTTP wrapper

Auth and access:

- JWT bearer tokens signed per database
- RBAC at table/field level
- anonymous public sessions
- PIN-based staff/admin login
- onboarding/access helpers for join codes, location access, brand lookup, and domain resolution

Routing:

- writes go to the leader of the table's primary cluster
- reads can stay local or fall back to another cluster
- site-scoped tables are automatically filtered by token scope

Threat model:

- token verification and RBAC are enforced in `netab`
- `steng` is trusted local storage
- `cord` transport security is outside the reference implementation and should be hardened in production
