#!/bin/sh
# Entry point of the redaction component, in two modes.
#
# `start.sh --own-volumes` runs as root in the one-shot `redactor-volumes`
# service before every start: it hands the three volumes to the unprivileged
# user the redactor runs as (REDACTOR_OWNER), recursively only when something
# in a volume is owned by anyone else, as volumes an earlier root-run build
# filled are. It needs no network and nothing but CAP_CHOWN and
# CAP_DAC_READ_SEARCH.
#
# `start.sh` with no mode runs as that user on a read-only root filesystem.
# It empties the scratch volume (TMPDIR, with HF_HOME and HOME under it),
# installs the pinned wheels into a virtual environment on the cache volume
# the first time, reuses it on every later start, then serves. The
# environment records which requirements file built it, so switching between
# the CPU and CUDA builds rebuilds it rather than serving a torch that cannot
# see the device it was given.
set -eu

VENV="${REDACTOR_VENV:-/opt/redactor/venv}"
MODELS="${REDACTOR_MODELS_DIR:-/models}"
SCRATCH="${TMPDIR:-/opt/redactor/tmp}"
APP="${REDACTOR_APP_DIR:-/opt/day0}"

if [ "$SCRATCH" = / ] || [ ! -d "$SCRATCH" ]; then
  echo "redactor: refusing to start: TMPDIR ($SCRATCH) is not a scratch directory it may empty" >&2
  exit 1
fi

if [ "${1:-}" = "--own-volumes" ]; then
  OWNER="${REDACTOR_OWNER:?REDACTOR_OWNER must name the uid:gid the redactor runs as}"
  for volume in "$VENV" "$MODELS" "$SCRATCH"; do
    if [ -n "$(find "$volume" ! -user "${OWNER%%:*}" -print -quit)" ] ||
      [ -n "$(find "$volume" ! -group "${OWNER##*:}" -print -quit)" ]; then
      echo "redactor: handing $volume to $OWNER"
      chown -R "$OWNER" "$volume"
    fi
  done
  exit 0
fi

# The scratch volume holds only what a start makes: pip's unpacked wheels and
# the libraries' caches. It is emptied so a failed install leaves nothing behind.
find "$SCRATCH" -mindepth 1 -delete
mkdir -p "${HF_HOME:-$SCRATCH/huggingface}" "${HOME:-$SCRATCH/home}" "${XDG_CACHE_HOME:-$SCRATCH/cache}"

case "${REDACTOR_DEVICE:-cpu}" in
  cuda) REQUIREMENTS="$APP/requirements-cuda.txt" ;;
  *) REQUIREMENTS="$APP/requirements.txt" ;;
esac
STAMP="$VENV/.requirements.sha256"
WANT="$(sha256sum "$REQUIREMENTS" | cut -d' ' -f1)"

if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$WANT" ]; then
  echo "redactor: installing wheels from $(basename "$REQUIREMENTS") into $VENV"
  # The directory is the volume's mount point, so it is emptied, not removed.
  mkdir -p "$VENV"
  find "$VENV" -mindepth 1 -delete
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --no-cache-dir --quiet --requirement "$REQUIREMENTS"
  echo "$WANT" > "$STAMP"
fi

exec "$VENV/bin/python" "$APP/server.py" "$@"
