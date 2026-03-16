# cord Deploy

For embedded clusters:

- instantiate one `CordNode` per running tablet node
- call `replicate_tick` on a short interval

For Linux/server clusters:

- pair one `CordNode` with one `netab` service instance
- run election/replication ticks inside the process supervisor or event loop
