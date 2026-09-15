#!/bin/sh
# Entry point of the redaction component. Installs the pinned wheels into a
# virtual environment on the cache volume the first time, reuses it on every
# later start, then serves. The environment records which requirements file
# built it, so switching between the CPU and CUDA builds rebuilds it rather
# than serving a torch that cannot see the device it was given.
set -eu

VENV="${REDACTOR_VENV:-/opt/redactor/venv}"
case "${REDACTOR_DEVICE:-cpu}" in
  cuda) REQUIREMENTS=/opt/day0/requirements-cuda.txt ;;
  *) REQUIREMENTS=/opt/day0/requirements.txt ;;
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

exec "$VENV/bin/python" /opt/day0/server.py "$@"
