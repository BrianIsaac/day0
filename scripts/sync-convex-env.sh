#!/usr/bin/env bash
# Push the env vars Convex actions need from .env.local to the Convex deployment.
# Run once after `pnpm convex:dev` has provisioned the deployment — or, when
# self-hosting, as soon as CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY
# are in .env.local and before the first push: `convex/auth.config.ts` reads
# NEXT_PUBLIC_DEV_NO_AUTH and DEV_NO_AUTH_JWKS off the deployment at push time,
# and refuses the push if the first is set without the second.
#
# Usage: ./scripts/sync-convex-env.sh

set -euo pipefail

ENV_FILE="${1:-.env.local}"
KEYS=(
  OPENAI_API_KEY
  OPENAI_BASE_URL
  OPENAI_MODEL
  OPENAI_IMAGE_MODEL
  OPENAI_JSON_MODE
  EXA_API_KEY
  DAYTONA_API_KEY
  DAYTONA_API_URL
  NEXT_PUBLIC_DEV_NO_AUTH
  DEV_NO_AUTH_JWKS
  NEXT_PUBLIC_DEMO_BOSS_EMAIL
  CLERK_JWT_ISSUER_DOMAIN
)

# Keys whose absence is meaningful: leaving a stale value on the deployment
# would be a silent security downgrade, so an empty local value removes them.
# These are the two `convex/auth.config.ts` reads to decide who may call it.
CLEAR_IF_EMPTY=(
  NEXT_PUBLIC_DEV_NO_AUTH
  DEV_NO_AUTH_JWKS
)

# Keys the deployment used to read and no longer does. A stale CONVEX_BIND_ADDR
# is inert, but it is the declaration two versions of the no-auth guard mistook
# for the socket, so it should not sit on a deployment looking meaningful.
RETIRED=(
  CONVEX_BIND_ADDR
)

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found"
  exit 1
fi

# The deployment cannot verify a no-auth caller's token without the public key,
# and a push in that state would refuse every caller. Say so here rather than
# leaving it to be discovered as a 'not authenticated' on the dashboard.
read_local() {
  grep -E "^${1}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true
}
if [ "$(read_local NEXT_PUBLIC_DEV_NO_AUTH)" = "true" ] && [ -z "$(read_local DEV_NO_AUTH_JWKS)" ]; then
  echo "error: NEXT_PUBLIC_DEV_NO_AUTH=true in $ENV_FILE but DEV_NO_AUTH_JWKS is empty." >&2
  echo "       No-auth mode accepts only callers holding this machine's local key," >&2
  echo "       and the deployment needs its public half to check one. Run" >&2
  echo "       \`pnpm dev:no-auth-key\`, then re-run this script." >&2
  exit 1
fi

# Clearing a CLEAR_IF_EMPTY key is the one step whose silent failure is a
# security downgrade rather than an inconvenience - an expired credential or the
# wrong deployment would otherwise print `clear …` and `done.` while the flag
# that disables authentication stays set. So the deployment's current env is
# read up front (a failure here is fatal), each clear is checked, and the
# absence is confirmed afterwards rather than assumed.
if ! deployment_env=$(npx convex env list 2>&1); then
  echo "error: could not read this deployment's env vars, so the ${CLEAR_IF_EMPTY[*]}" >&2
  echo "       clears below cannot be confirmed. Check your Convex credentials and" >&2
  echo "       deployment selection, then re-run." >&2
  printf '%s\n' "$deployment_env" >&2
  exit 1
fi

clear_key() {
  local key="$1" reason="${2:-empty in $ENV_FILE}" output
  if ! grep -qE "^${key}=" <<<"$deployment_env"; then
    echo "clear ${key} (already absent)"
    return 0
  fi
  echo "clear ${key} (${reason})"
  if ! output=$(npx convex env remove "$key" 2>&1); then
    echo "error: failed to remove ${key} from the deployment - it is still set there." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if ! output=$(npx convex env list 2>&1); then
    echo "error: removed ${key} but could not confirm it is gone. Re-run this script." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if grep -qE "^${key}=" <<<"$output"; then
    echo "error: ${key} is still set on the deployment after the remove call." >&2
    exit 1
  fi
}

for key in "${RETIRED[@]}"; do
  clear_key "$key" "no longer read by the deployment"
done

for key in "${KEYS[@]}"; do
  value=$(read_local "$key")
  if [ -z "$value" ]; then
    if [[ " ${CLEAR_IF_EMPTY[*]} " == *" ${key} "* ]]; then
      clear_key "$key"
    else
      echo "skip ${key} (empty in $ENV_FILE)"
    fi
    continue
  fi
  echo "set  ${key}"
  if ! output=$(npx convex env set "$key" "$value" 2>&1); then
    echo "error: failed to set ${key} on the deployment." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
done

echo "done."
