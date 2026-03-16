# netab Deploy

Reference process modes:

- embedded tablet mode: instantiate `NetabService` directly inside the app
- HTTP mode: wrap `NetabService` with `startNetabHttpServer`

Expected external pieces:

- router DNS / reverse proxy
- TLS termination
- service registration / health checks
- persistent storage adapter when moving beyond the in-memory reference engine
