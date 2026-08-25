#!/usr/bin/env bash
# Push the env vars Convex actions need from .env.local to the Convex deployment.
# Run once after `pnpm convex:dev` has provisioned the deployment - or, when
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
  SKILL_SANDBOX_SOCKET
  NOTION_TOKEN
  LINEAR_API_KEY
  SLACK_BOT_TOKEN
  SLACK_MCP_API_KEY
  NEXT_PUBLIC_DEMO_BOSS_EMAIL
  CLERK_JWT_ISSUER_DOMAIN
)

# The two `convex/auth.config.ts` reads to decide who may call the deployment.
# They are handled apart from KEYS because their order is load-bearing and it
# is not the same order in both directions: a deployment that already has
# functions on it validates its auth config on *every* env change, and rejects
# any single step that would leave the config invalid. So the flag may never be
# set before the key exists, nor the key removed while the flag still says to
# use it. Getting this wrong fails only once functions are pushed, which is why
# it survived a self-hosted backend that had not been pushed to yet.
NO_AUTH_FLAG=NEXT_PUBLIC_DEV_NO_AUTH
NO_AUTH_JWKS=DEV_NO_AUTH_JWKS

# Their absence is also meaningful, which is why they are the only two removed
# rather than skipped when empty: leaving a stale flag on the deployment would
# be a silent security downgrade rather than an inconvenience.

# Keys the deployment must see under a different name than .env.local uses.
# OPENAI_BASE_URL is the only one so far, and it exists because the deployment
# is somewhere else: Node actions dial the model from inside the backend
# container, where the loopback address Next uses means the container itself.
# CONVEX_OPENAI_BASE_URL is that same endpoint as the backend must address it.
# Unset, the local value is pushed unchanged, which is right for Convex cloud
# and for any endpoint both sides can reach by the same name.
declare -A ALIASED=(
  [OPENAI_BASE_URL]=CONVEX_OPENAI_BASE_URL
)

# Keys whose absence is a setting rather than an omission, and so must be
# removed from the deployment rather than left alone when .env.local has
# nothing to say. OPENAI_BASE_URL unset means api.openai.com. A missing provider
# token likewise means that deployment access has been revoked, not that a
# previous value should remain available to an action.
CLEAR_WHEN_EMPTY=(
  OPENAI_BASE_URL
  NOTION_TOKEN
  LINEAR_API_KEY
  SLACK_BOT_TOKEN
  SLACK_MCP_API_KEY
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

# Clearing the no-auth pair is the one step whose silent failure is a security
# downgrade rather than an inconvenience - an expired credential or the wrong
# deployment would otherwise print `clear …` and `done.` while the flag that
# disables authentication stays set. So the deployment's current env is read up
# front (a failure here is fatal), each clear is checked, and the absence is
# confirmed afterwards rather than assumed.
if ! deployment_env=$(npx convex env list 2>&1); then
  echo "error: could not read this deployment's env vars, so the ${NO_AUTH_FLAG}/${NO_AUTH_JWKS}" >&2
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

set_key() {
  local key="$1" value="$2" note="${3:-}" output
  echo "set  ${key}${note:+ (${note})}"
  if ! output=$(npx convex env set "$key" "$value" 2>&1); then
    echo "error: failed to set ${key} on the deployment." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

for key in "${RETIRED[@]}"; do
  clear_key "$key" "no longer read by the deployment"
done

# The no-auth pair, in whichever order keeps the auth config valid at every
# single step: turning the mode on means the key first, turning it off means
# the flag first.
no_auth_flag_value=$(read_local "$NO_AUTH_FLAG")
no_auth_jwks_value=$(read_local "$NO_AUTH_JWKS")
if [ "$no_auth_flag_value" = "true" ]; then
  set_key "$NO_AUTH_JWKS" "$no_auth_jwks_value" "before the flag that requires it"
  set_key "$NO_AUTH_FLAG" "$no_auth_flag_value"
else
  [ -n "$no_auth_flag_value" ] && set_key "$NO_AUTH_FLAG" "$no_auth_flag_value" || clear_key "$NO_AUTH_FLAG"
  [ -n "$no_auth_jwks_value" ] && set_key "$NO_AUTH_JWKS" "$no_auth_jwks_value" ||
    clear_key "$NO_AUTH_JWKS" "after the flag that required it"
fi

for key in "${KEYS[@]}"; do
  override_var="${ALIASED[$key]:-}"
  override=""
  [ -n "$override_var" ] && override=$(read_local "$override_var")
  if [ -n "$override" ]; then
    set_key "$key" "$override" "from ${override_var}"
    continue
  fi
  value=$(read_local "$key")
  if [ -z "$value" ]; then
    if [[ " ${CLEAR_WHEN_EMPTY[*]} " == *" ${key} "* ]]; then
      clear_key "$key" "empty in $ENV_FILE, so the deployment falls back to OpenAI"
    else
      echo "skip ${key} (empty in $ENV_FILE)"
    fi
    continue
  fi
  set_key "$key" "$value"
done

# A self-hosted deployment runs its Node actions inside a container, so a model
# endpoint on loopback resolves to the container and not to your machine. The
# resulting failure is a quiet one - the Day-1 chat streams from Next and works,
# and only the charter, which is synthesised in an action, never arrives.
backend_model_url=$(read_local CONVEX_OPENAI_BASE_URL)
[ -z "$backend_model_url" ] && backend_model_url=$(read_local OPENAI_BASE_URL)
if [ -n "$(read_local CONVEX_SELF_HOSTED_URL)" ] &&
  grep -qE '^https?://(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)([:/]|$)' <<<"$backend_model_url"; then
  echo
  echo "warning: the deployment will call the model at ${backend_model_url}, which inside" >&2
  echo "         the backend container means the container itself. Set" >&2
  echo "         CONVEX_OPENAI_BASE_URL to an address that resolves in there -" >&2
  echo "         http://model:11434/v1 with \`pnpm model:up\`, or" >&2
  echo "         http://host.docker.internal:11434/v1 for a server on this host." >&2
fi

# Deployment env is read when a function module is first evaluated, and a
# backend that has already run one keeps the values it started with. Changing
# them later without restarting leaves the deployment reporting the new value
# while the running action still uses the old one.
echo
echo "done. If the backend has already run an action since these values last changed,"
echo "restart it so they take effect: \`pnpm convex:restart\` (self-hosted)."
