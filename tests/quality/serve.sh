#!/usr/bin/env bash
# Starts what the quality run looks at (CI only, .github/workflows/quality.yml; never on the VM):
#   - the built site (dist/) under `wrangler pages dev` on 127.0.0.1:8788, with a local D1 and R2
#     and a throwaway admin password made up for this run (APP_SECRET and ADMIN_PASSWORD_HASH in a
#     .dev.vars that exists only in the runner; neither is a real secret);
#   - the learner pages (tests/quality/learner-server.mjs) on 127.0.0.1:8790.
# Then signs in to the admin once and exports ADMIN_COOKIE (masked) to the later steps.
set -euo pipefail

state="${RUNNER_TEMP:-$(mktemp -d)}/quality"
mkdir -p "$state"

secret=$(openssl rand -hex 32)
password=$(openssl rand -hex 16)
hash=$(printf '%s' "$password" | openssl dgst -sha256 -hmac "$secret" -hex | awk '{print $NF}')
printf 'APP_SECRET=%s\nADMIN_PASSWORD_HASH=%s\n' "$secret" "$hash" > .dev.vars

npx wrangler pages dev dist --d1 DB --r2 MEDIA --ip 127.0.0.1 --port 8788 \
  --compatibility-date 2026-10-01 --persist-to "$state/pages-dev" > "$state/pages-dev.log" 2>&1 &
echo $! > "$state/pages-dev.pid"
node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs \
  tests/quality/learner-server.mjs 8790 > "$state/learner.log" 2>&1 &
echo $! > "$state/learner.pid"

for url in http://127.0.0.1:8788/ http://127.0.0.1:8790/account; do
  for i in $(seq 1 90); do
    if curl -fsS -o /dev/null "$url"; then break; fi
    if [ "$i" = 90 ]; then echo "serve: $url didn't come up"; tail -50 "$state/pages-dev.log" "$state/learner.log"; exit 1; fi
    sleep 1
  done
done
# The first request ran the D1 migrations; warm the course host and the learner pages too.
curl -fsS -o /dev/null http://selfmakeup.localhost:8788/ || true

cookie=$(curl -fsS -D - -o /dev/null -X POST http://127.0.0.1:8788/api/admin/login \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8788' \
  --data "{\"password\":\"$password\"}" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-fbc_admin=[^;]*\).*/\1/p')
if [ -z "$cookie" ]; then echo "serve: admin sign-in failed"; tail -50 "$state/pages-dev.log"; exit 1; fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "::add-mask::${cookie#*=}"
  echo "ADMIN_COOKIE=$cookie" >> "$GITHUB_ENV"
fi
echo "serve: site on :8788, learner pages on :8790, admin signed in"
