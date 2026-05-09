#!/usr/bin/env bash
# Push the env vars Convex actions need from .env.local to the Convex deployment.
# Run once after `pnpm convex:dev` has provisioned the deployment.
#
# Usage: ./scripts/sync-convex-env.sh

set -euo pipefail

ENV_FILE="${1:-.env.local}"
KEYS=(
  OPENAI_API_KEY
  OPENAI_MODEL
  OPENAI_IMAGE_MODEL
  EXA_API_KEY
  DAYTONA_API_KEY
  DAYTONA_API_URL
)

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found"
  exit 1
fi

for key in "${KEYS[@]}"; do
  value=$(grep -E "^${key}=" "$ENV_FILE" | head -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true)
  if [ -z "$value" ]; then
    echo "skip ${key} (empty in $ENV_FILE)"
    continue
  fi
  echo "set  ${key}"
  npx convex env set "$key" "$value" >/dev/null
done

echo "done."
