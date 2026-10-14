#!/usr/bin/env bash
# Starts a throwaway local Postgres 16 that mimics the parts of Supabase the app relies on
# (auth schema, roles, auth.uid()). Used for tests and local dev only — production is Supabase.
set -euo pipefail
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
DATA=${LOCAL_PGDATA:-.localdb}
PORT=${LOCAL_PGPORT:-54329}
# Postgres refuses to run as root; in containers, run it as the postgres user.
RUN=()
if [ "$(id -u)" = "0" ]; then
  RUN=(runuser -u postgres --)
  DATA=$(realpath -m "$DATA"); mkdir -p "$DATA"; chown postgres "$DATA"
fi
if [ ! -f "$DATA/PG_VERSION" ]; then
  "${RUN[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
fi
if ! "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log.txt" start >/dev/null
  sleep 1
fi
for db in leadline leadline_test; do
  psql -h 127.0.0.1 -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || psql -h 127.0.0.1 -p "$PORT" -U postgres -c "create database $db" >/dev/null
done
echo "Local Postgres on port $PORT (databases: leadline, leadline_test)"
