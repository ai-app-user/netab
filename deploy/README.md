# Deployment Notes

Reference deployment shapes:

- Embedded tablet node: `steng + cord + netab + app_helpers/pos` inside one app runtime.
- Offline cluster: 3-10 tablet nodes on the same LAN, one active leader, remaining replicas.
- Online cluster: one or more Linux nodes running `netab` behind an HTTP proxy, optionally serving as archive fallback.
- Browser client: uses the `netab` HTTP API via split-horizon DNS and a router/reverse proxy.

This repository ships the application/runtime code. Router DNS, HAProxy, TLS, and OpenWrt automation remain deployment-specific.
