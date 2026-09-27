#!/usr/bin/env bash
# Day0 on this machine, in one command. Real mode: your own documentation and
# the systems it names. The only choice is where the model runs.
#
#   ./setup.sh --route featherless     Local, cloud model: GLM 5.3 Flash through Featherless
#   ./setup.sh --route key             Local, cloud model: OpenAI, or any OpenAI-compatible key
#   ./setup.sh --route endpoint --endpoint <url>
#                                      Local, cloud model: a server you already run
#   ./setup.sh --route local           Local, local model: the bundled model, no account
#   ./setup.sh stop | resume | clear   stop for the day, come back, or throw it away
#
# This checks the tools the setup needs (the Docker daemon itself, not only
# its client), installs the dependencies if they are not there yet (never on
# --dry-run), and hands everything else to the typed, tested entry:
# `pnpm setup:local --mode real`. Every flag goes straight through, so
# `pnpm setup:local --help` is the full list. Mock mode, the seeded office the
# evaluation harness and the hosted demo run on, stays `pnpm setup:local`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  cat <<'USAGE'
Usage: ./setup.sh --route <featherless|key|endpoint|local> [setup flags]
       ./setup.sh stop | resume | clear [--yes] [--purge-env]

Real mode, on your own documentation and systems: day0 reads the pages you
link and, once you approve a card, acts on the systems those pages record.
Both local ways to run Day0 are this command; the only choice is where the
model runs.

Local, cloud model
  ./setup.sh --route featherless    GLM 5.3 Flash through Featherless. The key is
                                    asked for in a hidden prompt, or read from
                                    FEATHERLESS_API_KEY.
  ./setup.sh --route key            OpenAI, or any OpenAI-compatible key, asked
                                    for in a hidden prompt.
  ./setup.sh --route endpoint --endpoint <url>
                                    an OpenAI-compatible server you already run.

Local, local model
  ./setup.sh --route local          The bundled model. What its volume already
                                    holds and what this project has tested are
                                    listed first; pick one, or pass --model <id>.
                                    A model already present is not pulled again.

Without --route it asks. Mock mode, the seeded office the evaluation harness
and the hosted demo run on, is `pnpm setup:local`, not this command.

Useful with any route:
  --warm-from <project>   copy another project's redactor volumes: no download
  --gpu off               keep a CPU-built redactor venv as it is
  --app-port <n>          the port `pnpm dev` serves on (default 3000)
  --docs <dir>            your documentation folder (default ./docs-local)
  --company               then copy the synthetic company bed's pages into that
                          folder and print its hand steps (bed/company/)
  --dry-run               print the plan of commands and write nothing
  --reset                 clear this project (containers and volumes) first

Stop for the day, come back, or throw it away; the project is read from .env.local:
  ./setup.sh stop     containers down; the data, model and redactor volumes
                      and .env.local are kept
  ./setup.sh resume   the same project on the same ports, the admin key kept,
                      nothing pulled again (running the setup again does the same)
  ./setup.sh clear    containers, volumes and network removed; .env.local kept
                      unless --purge-env; asks first unless --yes

Everything else, ports and project names included: pnpm setup:local --help
USAGE
}

for argument in "$@"; do
  case "$argument" in
    -h | --help)
      usage
      exit 0
      ;;
  esac
done

major() {
  # The first integer in whatever a tool prints for --version.
  printf '%s' "$1" | grep -oE '[0-9]+' | head -n1
}

missing=0
if ! command -v node >/dev/null 2>&1 || [ "$(major "$(node --version)")" -lt 22 ]; then
  echo "gap  Node 22 or newer is needed; found: $(node --version 2>/dev/null || echo 'none on the path')." >&2
  echo "     nvm install 22 && nvm use 22" >&2
  missing=1
fi
if ! command -v pnpm >/dev/null 2>&1 || [ "$(major "$(pnpm --version)")" -lt 9 ]; then
  echo "gap  pnpm 9 or newer is needed; found: $(pnpm --version 2>/dev/null || echo 'none on the path')." >&2
  echo "     corepack enable && corepack prepare pnpm@9 --activate" >&2
  missing=1
fi
# The env sync the setup runs is a bash script with associative arrays, and it
# runs under whichever bash is first on the path; macOS ships 3.2.
path_bash="$(major "$(bash -c 'echo "${BASH_VERSINFO[0]}"' 2>/dev/null || true)")"
if [ "${path_bash:-0}" -lt 4 ]; then
  echo "gap  bash 4 or newer is needed on the path; found: $(bash -c 'echo "$BASH_VERSION"' 2>/dev/null || echo 'none')." >&2
  echo "     macOS ships bash 3.2: brew install bash, then open a new terminal." >&2
  missing=1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker --version >/dev/null 2>&1; then
  echo "gap  Docker is needed and is not on the path. Install Docker Desktop or Docker Engine." >&2
  missing=1
elif ! daemon="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
  # The client answers on its own; only the daemon can say whether it runs and
  # whether this user may talk to it, so its own words are kept.
  reason="$(printf '%s' "$daemon" | grep -v '^[[:space:]]*$' | head -n1)"
  case "$daemon" in
    *"permission denied"*)
      echo "gap  Docker is installed and this user may not reach its daemon: ${reason}" >&2
      echo "     Add yourself to the docker group and log in again: sudo usermod -aG docker \"\$USER\"" >&2
      ;;
    *)
      echo "gap  Docker is installed and its daemon did not answer: ${reason}" >&2
      echo "     Start Docker Desktop, or the service: sudo systemctl start docker" >&2
      ;;
  esac
  missing=1
elif ! compose_version="$(docker compose version 2>&1)"; then
  reason="$(printf '%s' "$compose_version" | grep -v '^[[:space:]]*$' | head -n1)"
  echo "gap  The Docker Compose v2 plugin (\`docker compose\`) did not answer: ${reason}" >&2
  echo "     Install it: Docker Desktop carries it; on Linux, the docker-compose-plugin package." >&2
  missing=1
elif compose_major="$(major "$compose_version")" && [ "${compose_major:-0}" -lt 2 ]; then
  echo "gap  Docker Compose v2 is needed; found: ${compose_version}. The old docker-compose v1 is not enough." >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  echo "" >&2
  echo "Nothing was started and nothing was written." >&2
  exit 1
fi

dry_run=0
for argument in "$@"; do
  if [ "$argument" = "--dry-run" ]; then dry_run=1; fi
done

if [ ! -d node_modules ]; then
  if [ "$dry_run" -eq 1 ]; then
    # A dry run writes nothing, and an install writes node_modules; the full
    # plan needs the dependencies, so it says what it would do and stops here.
    echo "Dry run. The prerequisites above are in place. The dependencies are not installed yet, so the"
    echo "plan cannot be printed without writing node_modules. The setup would run, in order:"
    echo "  pnpm install --frozen-lockfile"
    echo "  pnpm setup:local --mode real $*"
    echo "Install them (pnpm install --frozen-lockfile) and run the dry run again for the full plan."
    echo "Nothing was started and nothing was written."
    exit 0
  fi
  echo "Installing dependencies (pnpm install --frozen-lockfile)..."
  pnpm install --frozen-lockfile
fi

exec pnpm setup:local --mode real "$@"
