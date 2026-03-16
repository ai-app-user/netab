#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${STENG_DB:=steng_dev}"
: "${STENG_ROLE:=steng}"
: "${STENG_ROLE_PASSWORD:=steng_dev_password}"
: "${STENG_SCHEMA:=steng}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required. Run install_postgres.sh first." >&2
  exit 1
fi

export PSQL_CONN=("psql" "-h" "${PGHOST}" "-p" "${PGPORT}" "-U" "${PGUSER}" "-d" "postgres" "-v" "ON_ERROR_STOP=1")

"${PSQL_CONN[@]}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STENG_ROLE}') THEN
    CREATE ROLE ${STENG_ROLE} LOGIN PASSWORD '${STENG_ROLE_PASSWORD}';
  ELSE
    ALTER ROLE ${STENG_ROLE} WITH LOGIN PASSWORD '${STENG_ROLE_PASSWORD}';
  END IF;
END
\$\$;
SQL

if ! "${PSQL_CONN[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='${STENG_DB}'" | grep -q 1; then
  "${PSQL_CONN[@]}" -c "CREATE DATABASE ${STENG_DB} OWNER ${STENG_ROLE};"
fi

psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${STENG_DB}" -v ON_ERROR_STOP=1 <<SQL
CREATE SCHEMA IF NOT EXISTS ${STENG_SCHEMA} AUTHORIZATION ${STENG_ROLE};
GRANT ALL PRIVILEGES ON SCHEMA ${STENG_SCHEMA} TO ${STENG_ROLE};
ALTER DATABASE ${STENG_DB} SET search_path TO ${STENG_SCHEMA},public;
SQL

echo "Initialized PostgreSQL for steng:"
echo "  database: ${STENG_DB}"
echo "  role:     ${STENG_ROLE}"
echo "  schema:   ${STENG_SCHEMA}"
