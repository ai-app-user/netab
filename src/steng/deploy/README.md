# steng Deploy

`steng` is embedded into another runtime, but this folder prepares the host dependencies that a real SQLite/Postgres-backed `steng` adapter will need.

Status:

- the current reference runtime still uses the in-memory engine
- these scripts prepare dev/test hosts and databases for the next persistence step

Files:

- [install_sqlite.sh](./install_sqlite.sh): installs SQLite CLI and dev headers
- [install_postgres.sh](./install_postgres.sh): installs PostgreSQL server/client/dev headers
- [init_postgres_steng.sh](./init_postgres_steng.sh): creates a `steng` role/database/schema
- [env.example](./env.example): environment variables for the Postgres init script

Typical local setup:

1. SQLite prerequisites

```bash
./src/steng/deploy/install_sqlite.sh
sqlite3 --version
```

2. PostgreSQL prerequisites

```bash
./src/steng/deploy/install_postgres.sh
cp src/steng/deploy/env.example .env.steng.pg
$EDITOR .env.steng.pg
set -a && source .env.steng.pg && set +a
./src/steng/deploy/init_postgres_steng.sh
```

3. Verify PostgreSQL

```bash
psql "postgresql://${STENG_ROLE}:${STENG_ROLE_PASSWORD}@${PGHOST}:${PGPORT}/${STENG_DB}" -c '\dt'
```

Notes:

- the install scripts support `apt-get`, `dnf`, and `brew`
- package installation may require `sudo`
- Postgres service startup is attempted when `systemctl` is available, otherwise the script prints the next manual step
