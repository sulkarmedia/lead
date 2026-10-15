#!/usr/bin/env bash
# One-time local setup: creates .env (practice mode, dev login), starts a local Postgres,
# applies migrations and loads the demo dealership.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')
  sed -e "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$KEY#" \
      -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://postgres@127.0.0.1:54329/leadline#" \
      -e "s#^DRY_RUN=.*#DRY_RUN=true#" -e "s#^DEV_LOGIN=.*#DEV_LOGIN=true#" \
      -e "s#^WORKER_POLL_SECONDS=.*#WORKER_POLL_SECONDS=5#" .env.example > .env
  echo "Created .env (practice mode: nothing is sent to real people)."
fi
bash scripts/local-db.sh
npm run db:migrate -- --shim
npm run seed
echo
echo "Done. Now run 'npm run dev' and, in a second terminal, 'npm run worker'."
echo "Then open http://localhost:3000/login and pick a demo user."
