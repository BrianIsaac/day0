#!/usr/bin/env bash
# Push the env vars Convex actions need from .env.local to the Convex deployment.
# Run once after `pnpm convex:dev` has provisioned the deployment - or, when
# self-hosting, as soon as CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY
# are in .env.local and before the first push: `convex/auth.config.ts` reads
# the identity settings (NEXT_PUBLIC_DEV_NO_AUTH with DEV_NO_AUTH_JWKS, and
# DAY0_OIDC_ISSUER with DAY0_OIDC_AUDIENCE) off the deployment at push time,
# and refuses the push if a flag or issuer is set without its partner, or if
# none of them (nor CLERK_JWT_ISSUER_DOMAIN) is set.
#
# Usage: ./scripts/sync-convex-env.sh

set -euo pipefail

ENV_FILE="${1:-.env.local}"
KEYS=(
  OPENAI_API_KEY
  OPENAI_BASE_URL
  OPENAI_MODEL
  OPENAI_JSON_MODE
  OPENAI_STRUCTURED_REPAIR_ATTEMPTS
  OPENAI_MAX_OUTPUT_TOKENS
  OPENAI_REASONING_EFFORT
  DAYTONA_API_KEY
  DAYTONA_API_URL
  SKILL_SANDBOX_SOCKET
  DAY0_SURFACE_MODE
  DAY0_PRIVATE_HOSTS
  DAY0_DOCS_ROOT
  DAY0_CREDENTIAL_KEY
  DAY0_NOTION_MCP_AUTH_TOKEN
  DAY0_PUBLIC_URL
  DAY0_BROWSER_MCP_URL
  DAY0_REDACTOR_URL
  DAY0_TEST_SLACK_API_URL
  DAY0_TEST_SLACK_AUTHORIZE_URL
  DAY0_EVALUATION_BED
  DAY0_OIDC_EMAIL_TRUSTED
  NEXT_PUBLIC_DEMO_BOSS_EMAIL
)

# The pairs `convex/auth.config.ts` reads to decide who may call the
# deployment: the local key's flag and its public half, the customer's issuer
# (A7) with its audience and the profile that runs it, and Clerk's issuer for
# the hosted demo. They are handled
# apart from KEYS because their order is load-bearing and it is not the same
# order in both directions: a deployment that already has functions on it
# validates its auth config on *every* env change, and rejects any single step
# that would leave the config invalid. So a flag or issuer is never set before
# its partner exists, nor a partner removed while the flag or issuer still
# needs it, and every addition comes before every removal, so a switch from one
# way in to the other never passes through a deployment with none. Getting
# this wrong fails only once functions are pushed, which is why it survived a
# self-hosted backend that had not been pushed to yet.
NO_AUTH_FLAG=NEXT_PUBLIC_DEV_NO_AUTH
NO_AUTH_JWKS=DEV_NO_AUTH_JWKS
OIDC_ISSUER=DAY0_OIDC_ISSUER
OIDC_AUDIENCE=DAY0_OIDC_AUDIENCE
PROFILE=DAY0_PROFILE
CLERK_ISSUER=CLERK_JWT_ISSUER_DOMAIN

# Their absence is also meaningful, which is why they are removed rather than
# skipped when empty: leaving a stale flag or issuer on the deployment would
# be a silent security downgrade rather than an inconvenience.

# Keys the deployment must see under a different name than .env.local uses.
# OPENAI_BASE_URL is the only one so far, and it exists because the deployment
# is somewhere else: Node actions dial the model from inside the backend
# container, where the loopback address Next uses means the container itself.
# CONVEX_OPENAI_BASE_URL is that same endpoint as the backend must address it.
# Unset, the local value is pushed unchanged, which is right for Convex cloud
# and for any endpoint both sides can reach by the same name. A function, not
# an associative array, so the script runs under the bash 3.2 macOS ships.
aliased_name() {
  case "$1" in
    OPENAI_BASE_URL) echo CONVEX_OPENAI_BASE_URL ;;
    *) echo "" ;;
  esac
}

# Keys whose absence is a setting rather than an omission, and so must be
# removed from the deployment rather than left alone when .env.local has
# nothing to say. OPENAI_BASE_URL unset means api.openai.com. A missing provider
# token likewise means that deployment access has been revoked, not that a
# previous value should remain available to an action.
CLEAR_WHEN_EMPTY=(
  OPENAI_STRUCTURED_REPAIR_ATTEMPTS
  OPENAI_MAX_OUTPUT_TOKENS
  OPENAI_REASONING_EFFORT
  OPENAI_BASE_URL
  DAY0_SURFACE_MODE
  # A host dropped from the list must stop being reachable, not linger there.
  DAY0_PRIVATE_HOSTS
  DAY0_CREDENTIAL_KEY
  DAY0_NOTION_MCP_AUTH_TOKEN
  # A quick tunnel's hostname changes on every restart, so a stale value here
  # would have an app manifest declaring a redirect that no longer resolves.
  # Clearing it makes provisioning refuse plainly instead.
  DAY0_PUBLIC_URL
  DAY0_BROWSER_MCP_URL
  # Unset means no redaction component: sync refuses and outcomes say so.
  DAY0_REDACTOR_URL
  DAY0_TEST_SLACK_API_URL
  DAY0_TEST_SLACK_AUTHORIZE_URL
  # A deployment that stops being an evaluation bed must stop serving the
  # harness, which seeds rows and spends model calls on the owner's keys (N9).
  DAY0_EVALUATION_BED
  # A stale trust flag would keep believing addresses the customer's issuer
  # never verified after the operator turned it off (D3).
  DAY0_OIDC_EMAIL_TRUSTED
)

# Keys the deployment used to read and no longer does. A stale CONVEX_BIND_ADDR
# is inert, but it is the declaration two versions of the no-auth guard mistook
# for the socket, so it should not sit on a deployment looking meaningful.
#
# The 26 Aug credential model replaced the env-var credential names with the
# encrypted `credentials` table: a deployment that still carries them would
# keep a provider token readable by any Node action long after the code
# stopped asking for it.
#
# A name leaves KEYS for this list, never just leaves: the sync sets only what
# it manages, so a name it stops managing would otherwise stay on every
# deployment it was ever pushed to. EXA_API_KEY went with Exa (N19), and
# OPENAI_IMAGE_MODEL when v0.7.0 found nothing read it.
RETIRED=(
  CONVEX_BIND_ADDR
  DAY0_SECRET_REFS
  NOTION_TOKEN
  LINEAR_API_KEY
  SLACK_BOT_TOKEN
  SLACK_MCP_API_KEY
  SLACK_MANAGER_DM_CHANNEL_ID
  EXA_API_KEY
  OPENAI_IMAGE_MODEL
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
if [ -n "$(read_local DAY0_OIDC_ISSUER)" ] && [ -z "$(read_local DAY0_OIDC_AUDIENCE)" ]; then
  echo "error: DAY0_OIDC_ISSUER is set in $ENV_FILE but DAY0_OIDC_AUDIENCE is empty." >&2
  echo "       The deployment refuses an issuer without the client id its tokens carry" >&2
  echo "       in \`aud\`. Set DAY0_OIDC_AUDIENCE, then re-run this script." >&2
  exit 1
fi
if [ "$(read_local DAY0_SURFACE_MODE)" = "real" ] && [ -z "$(read_local DAY0_CREDENTIAL_KEY)" ]; then
  echo "error: DAY0_SURFACE_MODE=real in $ENV_FILE but DAY0_CREDENTIAL_KEY is empty." >&2
  echo "       Run \`pnpm dev:no-auth-key\` once, then re-run this script." >&2
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

# The credential key sealed every credential the deployment stores, so while
# it stores any, the key is never cleared or replaced here: either would leave
# every stored credential unreadable. A restore adopts the deployment's key
# into .env.local first (./setup.sh restore); a deliberate rotation is
# scripts/rotate-credential-key.ts, which asks and sets the deployment itself.
guard_credential_key() {
  local wanted="$1" held output
  held=$(grep -E "^DAY0_CREDENTIAL_KEY=" <<<"$deployment_env" | head -n1 | cut -d= -f2- || true)
  if [ -z "$held" ] || [ "$held" = "$wanted" ]; then
    return 0
  fi
  if ! output=$(npx convex data credentials --limit 1 --format jsonl 2>&1); then
    echo "error: could not read whether this deployment stores credentials, so DAY0_CREDENTIAL_KEY" >&2
    echo "       is left as it is there. Check the Convex values in $ENV_FILE, then re-run." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if grep -q '^{' <<<"$output"; then
    if [ -z "$wanted" ]; then
      echo "error: $ENV_FILE has no DAY0_CREDENTIAL_KEY, and this deployment stores credentials" >&2
      echo "       sealed under the key it holds. Clearing it would leave every one unreadable." >&2
    else
      echo "error: DAY0_CREDENTIAL_KEY in $ENV_FILE is not the key this deployment holds, and the" >&2
      echo "       deployment stores credentials sealed under its own. Pushing yours would leave" >&2
      echo "       every one unreadable." >&2
    fi
    echo "       Adopt the deployment's key: \`npx convex env get DAY0_CREDENTIAL_KEY\` into $ENV_FILE." >&2
    echo "       To change it on purpose: pnpm exec tsx scripts/rotate-credential-key.ts" >&2
    exit 1
  fi
}

# A value the deployment already holds is not set again: `convex env set` is
# one CLI call per key, and a resume after `stop` would otherwise pay for
# every key to change nothing. The comparison is the whole `KEY=value` line
# as `convex env list` printed it, so a value it prints differently is simply
# set again, which is the safe direction.
set_key() {
  local key="$1" value="$2" note="${3:-}" output
  if grep -qxF -- "${key}=${value}" <<<"$deployment_env"; then
    echo "keep ${key} (unchanged)"
    return 0
  fi
  echo "set  ${key}${note:+ (${note})}"
  # `--` before the value: a base64url token can begin with `-`, which the CLI
  # would otherwise read as an option.
  if ! output=$(npx convex env set "$key" -- "$value" 2>&1); then
    echo "error: failed to set ${key} on the deployment." >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

# Before any change: a refusal here must leave the deployment exactly as it was.
guard_credential_key "$(read_local DAY0_CREDENTIAL_KEY)"

for key in "${RETIRED[@]}"; do
  clear_key "$key" "no longer read by the deployment"
done

# One key set when .env.local has a value, removed when it has none.
sync_key() {
  local key="$1" note="${2:-}" value
  value=$(read_local "$key")
  if [ -n "$value" ]; then
    set_key "$key" "$value" "$note"
  else
    clear_key "$key" "empty in $ENV_FILE${note:+, ${note}}"
  fi
}

# The identity pairs, in whichever order keeps the auth config valid at every
# single step: turning a way in on means its partner first, turning it off
# means the flag or issuer first, and every way in turned on comes before any
# turned off.
no_auth_flag_value=$(read_local "$NO_AUTH_FLAG")
no_auth_jwks_value=$(read_local "$NO_AUTH_JWKS")
oidc_issuer_value=$(read_local "$OIDC_ISSUER")
# Clerk, the hosted demo's way in, needs no partner; left alone when empty.
clerk_value=$(read_local "$CLERK_ISSUER")
if [ -n "$clerk_value" ]; then
  set_key "$CLERK_ISSUER" "$clerk_value"
else
  echo "skip ${CLERK_ISSUER} (empty in $ENV_FILE)"
fi
if [ -n "$oidc_issuer_value" ]; then
  sync_key "$PROFILE"
  sync_key "$OIDC_AUDIENCE" "before the issuer that requires it"
  set_key "$OIDC_ISSUER" "$oidc_issuer_value"
fi
if [ "$no_auth_flag_value" = "true" ]; then
  set_key "$NO_AUTH_JWKS" "$no_auth_jwks_value" "before the flag that requires it"
  set_key "$NO_AUTH_FLAG" "$no_auth_flag_value"
fi
if [ -z "$oidc_issuer_value" ]; then
  clear_key "$OIDC_ISSUER"
  sync_key "$OIDC_AUDIENCE" "after the issuer that required it"
  sync_key "$PROFILE"
fi
if [ "$no_auth_flag_value" != "true" ]; then
  [ -n "$no_auth_flag_value" ] && set_key "$NO_AUTH_FLAG" "$no_auth_flag_value" || clear_key "$NO_AUTH_FLAG"
  [ -n "$no_auth_jwks_value" ] && set_key "$NO_AUTH_JWKS" "$no_auth_jwks_value" ||
    clear_key "$NO_AUTH_JWKS" "after the flag that required it"
fi

# Convex function analysis does not supply NODE_ENV. The real-mode guard uses
# the same development-only invariant as Next, so the local deployment must
# receive that explicit value before modules are pushed. Leaving real mode
# removes it again, and DAY0_SURFACE_MODE itself is cleared below when empty:
# a deployment that kept `real` after .env.local went back to mock would keep
# linking documentation and orienting surfaces while the local file said
# otherwise.
if [ "$(read_local DAY0_SURFACE_MODE)" = "real" ]; then
  set_key NODE_ENV development "local real-mode guard"
else
  clear_key NODE_ENV "only needed by the real-mode guard"
fi

for key in "${KEYS[@]}"; do
  override_var=$(aliased_name "$key")
  override=""
  [ -n "$override_var" ] && override=$(read_local "$override_var")
  if [ -n "$override" ]; then
    set_key "$key" "$override" "from ${override_var}"
    continue
  fi
  value=$(read_local "$key")
  if [ -z "$value" ]; then
    if [[ " ${CLEAR_WHEN_EMPTY[*]} " == *" ${key} "* ]]; then
      clear_key "$key" "empty in $ENV_FILE, so the deployment falls back to its default"
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
