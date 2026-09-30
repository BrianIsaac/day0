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
#   ./setup.sh backup | restore <file> | upgrade
#                                      keep a copy, put it back, or move to this checkout's release
#   ./setup.sh pause | unpause         hold the scheduled jobs, or let them run again
#
#   ./setup.sh cloud setup --target <file>
#                                      Convex cloud and Vercel: the first push to an empty
#                                      production deployment, and the app deployed onto it
#   ./setup.sh cloud upgrade --target <file>
#                                      an export, then this tag pushed, migrated, stamped
#                                      and deployed, both halves read back
#   ./setup.sh cloud backup --target <file>
#                                      an export with its checksum and row counts
#   ./setup.sh cloud pause | unpause --target <file>
#                                      hold a real-mode cloud deployment's scheduled jobs
#
# This checks the tools the setup needs (the Docker daemon itself, not only
# its client), installs the dependencies if they are not there yet (never on
# --dry-run), and hands everything else to the typed, tested entry:
# `pnpm setup:local --mode real`. Every flag goes straight through, so
# `pnpm setup:local --help` is the full list. Mock mode, the seeded office the
# evaluation harness and the hosted demo run on, stays `pnpm setup:local`.
# `cloud` needs no Docker: it checks Node and pnpm and hands its verb to
# `scripts/setup-cloud.ts`, whose `./setup.sh cloud --help` is its full list.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
  cat <<'USAGE'
Usage: ./setup.sh --route <featherless|key|endpoint|local> [setup flags]
       ./setup.sh stop | resume | clear [--yes] [--purge-env]
       ./setup.sh backup | restore <file> | upgrade [--yes] [--to <dir>]
       ./setup.sh pause | unpause [--dry-run]
       ./setup.sh cloud setup | upgrade | backup | pause | unpause --target <file>

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

Keep a copy, put it back, or move to this checkout's release:
  ./setup.sh backup           the data volume to ~/day0-backups/<project>, with a
                              checksum (--to <dir> for another place)
  ./setup.sh restore <file>   replace the data volume with that backup, adopt its
                              credential key, then resume; asks first unless --yes
  ./setup.sh upgrade          after a git pull: a backup, pnpm install, then resume,
                              which refuses to skip a release and runs the migrations.
                              A mock deployment upgrades with pnpm setup:local upgrade.

Hold the scheduled jobs, with the stack up:
  ./setup.sh pause     the intake and decision polls, the digests, the sweeps and
                       the documentation sync skip until unpause; the backend
                       restarts so every job reads it. Work already scheduled
                       runs to its end.
  ./setup.sh unpause   lift the pause; each job runs again at its next turn

Your own copy on Convex cloud and Vercel, from a clean checkout of a release
tag with no .env.local; <file> sits outside the checkout and holds
CONVEX_DEPLOYMENT=prod:<name>, the production deployment:
  ./setup.sh cloud setup --target <file>     the first push to an empty production
                                             deployment, its settings from --env-file
                                             or hidden prompts, and the app deployed
  ./setup.sh cloud upgrade --target <file>   an export first, then this release pushed,
                                             migrated, stamped and deployed, one
                                             release at a time, both halves read back
  ./setup.sh cloud backup --target <file>    an export with its checksum and row counts
  ./setup.sh cloud pause | unpause --target <file>
                                             hold a real-mode deployment's jobs, or not
  Setup and upgrade end with their rollback runbook; --dry-run runs every read
  and changes nothing. The full list: ./setup.sh cloud --help

Everything else, ports and project names included: pnpm setup:local --help
USAGE
}

major() {
  # The first integer in whatever a tool prints for --version, or nothing.
  # awk exits 0 either way, so no pipeline here can stop the script under
  # errexit and pipefail before it has said what is missing.
  printf '%s\n' "$1" | awk 'match($0, /[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }'
}

first_line() {
  # The first line with anything on it, or nothing.
  printf '%s\n' "$1" | awk 'NF { print; exit }'
}

check_node_and_pnpm() {
  # Sets missing=1 and says what to do for each of the two that is absent or old.
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
}

install_dependencies() {
  # install_dependencies <dry run 0|1> <the typed command it would hand over to>
  if [ -d node_modules ]; then return 0; fi
  if [ "$1" -eq 1 ]; then
    # A dry run writes nothing, and an install writes node_modules; the full
    # plan needs the dependencies, so it says what it would do and stops here.
    echo "Dry run. The prerequisites above are in place. The dependencies are not installed yet, so the"
    echo "plan cannot be printed without writing node_modules. The setup would run, in order:"
    echo "  pnpm install --frozen-lockfile"
    echo "  $2"
    echo "Install them (pnpm install --frozen-lockfile) and run the dry run again for the full plan."
    echo "Nothing was started and nothing was written."
    exit 0
  fi
  echo "Installing dependencies (pnpm install --frozen-lockfile)..."
  pnpm install --frozen-lockfile
}

dry_run=0
for argument in "$@"; do
  if [ "$argument" = "--dry-run" ]; then dry_run=1; fi
done

missing=0
if [ "${1:-}" = "cloud" ]; then
  # Convex cloud and Vercel need no Docker, and `cloud --help` is the typed
  # entry's own, so this comes before the local checks and the usage above.
  shift
  check_node_and_pnpm
  if [ "$missing" -ne 0 ]; then
    echo "" >&2
    echo "Nothing was read, pushed or deployed." >&2
    exit 1
  fi
  for argument in "$@"; do
    case "$argument" in
      -h | --help)
        # The typed entry prints the cloud help, and it needs the dependencies;
        # asking for help installs nothing.
        [ -d node_modules ] && exec pnpm exec tsx scripts/setup-cloud.ts --help
        echo "The cloud verbs' help comes from scripts/setup-cloud.ts, which needs the dependencies:"
        echo "  pnpm install --frozen-lockfile && ./setup.sh cloud --help"
        exit 0
        ;;
    esac
  done
  install_dependencies "$dry_run" "pnpm exec tsx scripts/setup-cloud.ts $*"
  exec pnpm exec tsx scripts/setup-cloud.ts "$@"
fi

for argument in "$@"; do
  case "$argument" in
    -h | --help)
      usage
      exit 0
      ;;
  esac
done

check_node_and_pnpm
if ! command -v docker >/dev/null 2>&1 || ! docker --version >/dev/null 2>&1; then
  echo "gap  Docker is needed and is not on the path. Install Docker Desktop or Docker Engine." >&2
  missing=1
elif ! daemon="$(docker info --format '{{.ServerVersion}} {{.Architecture}}' 2>&1)"; then
  # The client answers on its own; only the daemon can say whether it runs and
  # whether this user may talk to it, so its own words are kept.
  reason="$(first_line "$daemon")"
  reason="${reason:-no message}"
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
elif case "$daemon" in *aarch64* | *arm64*) true ;; *) false ;; esac; then
  # This entry is real mode, and real mode reads documentation through the
  # redactor, whose wheel locks are compiled for x86_64 Linux only.
  echo "gap  This Docker daemon runs $(printf '%s' "$daemon" | awk '{ print $NF }') containers, and the redactor's wheel locks are x86_64 only." >&2
  echo "     Real mode needs an x86_64 machine for now; mock mode (pnpm setup:local) runs here." >&2
  missing=1
elif ! compose_version="$(docker compose version 2>&1)"; then
  reason="$(first_line "$compose_version")"
  reason="${reason:-no message}"
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

install_dependencies "$dry_run" "pnpm setup:local --mode real $*"

exec pnpm setup:local --mode real "$@"
