#!/usr/bin/env bash
# Push the env vars Convex actions need from .env.local to the Convex deployment.
# Run once after `pnpm convex:dev` has provisioned the deployment — or, when
# self-hosting, as soon as CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY
# are in .env.local and before the first push: `convex/auth.config.ts` reads
# NEXT_PUBLIC_DEV_NO_AUTH off the deployment at push time.
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
  NEXT_PUBLIC_DEMO_BOSS_EMAIL
  CLERK_JWT_ISSUER_DOMAIN
)

# Keys whose absence is meaningful: leaving a stale value on the deployment
# would be a silent security downgrade, so an empty local value removes them.
CLEAR_IF_EMPTY=(
  NEXT_PUBLIC_DEV_NO_AUTH
)

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found"
  exit 1
fi

for key in "${KEYS[@]}"; do
  value=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true)
  if [ -z "$value" ]; then
    if [[ " ${CLEAR_IF_EMPTY[*]} " == *" ${key} "* ]]; then
      echo "clear ${key} (empty in $ENV_FILE)"
      npx convex env remove "$key" >/dev/null 2>&1 || true
    else
      echo "skip ${key} (empty in $ENV_FILE)"
    fi
    continue
  fi
  echo "set  ${key}"
  npx convex env set "$key" "$value" >/dev/null
done

echo "done."
