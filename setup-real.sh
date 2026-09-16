#!/usr/bin/env bash
# Real mode in one command, for a fresh clone or the venue laptop.
#
#   ./setup-real.sh --route featherless    GLM 5.3 Flash through Featherless; the key is asked for
#   ./setup-real.sh --route local          the bundled model; present and tested models are listed
#   ./setup-real.sh stop | resume | clear  stop for the day, come back, or throw it away
#
# This checks the three tools the setup needs, installs the dependencies if
# they are not there yet, and hands everything else to the typed, tested entry:
# `pnpm setup:local --mode real`. Every flag goes straight through, so
# `pnpm setup:local --help` is the full list.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  cat <<'USAGE'
Usage: ./setup-real.sh --route <featherless|local> [setup flags]
       ./setup-real.sh stop | resume | clear [--yes] [--purge-env]

Real mode: day0 reads the documentation you point it at and, once you approve
a card, acts on the systems those pages record. Two routes:

  ./setup-real.sh --route featherless    GLM 5.3 Flash through Featherless.
                                         The key is asked for in a hidden prompt,
                                         or read from FEATHERLESS_API_KEY.
  ./setup-real.sh --route local          The bundled model. What its volume already
                                         holds and what this project has tested are
                                         listed first; pick one, or pass --model <id>.
                                         A model already present is not pulled again.

Useful with either:
  --warm-from <project>   copy another project's redactor volumes: no download
  --gpu off               keep a CPU-built redactor venv as it is
  --app-port <n>          the port `pnpm dev` serves on (default 3000)
  --docs <dir>            your documentation folder (default ./docs-local)
  --dry-run               print the plan of commands and write nothing
  --reset                 clear this project (containers and volumes) first

Stop for the day, come back, or throw it away; the project is read from .env.local:
  ./setup-real.sh stop     containers down; the data, model and redactor volumes
                           and .env.local are kept
  ./setup-real.sh resume   the same project on the same ports, the admin key kept,
                           nothing pulled again (running the setup again does the same)
  ./setup-real.sh clear    containers, volumes and network removed; .env.local kept
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
if ! command -v docker >/dev/null 2>&1 || ! docker --version >/dev/null 2>&1; then
  echo "gap  Docker is needed and did not answer. Start Docker Desktop or the docker service." >&2
  missing=1
elif ! compose_version="$(docker compose version 2>/dev/null)" || [ "$(major "$compose_version")" -lt 2 ]; then
  echo "gap  Docker Compose v2 is needed; docker-compose v1 is not enough." >&2
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  echo "" >&2
  echo "Nothing was started and nothing was written." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (pnpm install --frozen-lockfile)..."
  pnpm install --frozen-lockfile
fi

exec pnpm setup:local --mode real "$@"
