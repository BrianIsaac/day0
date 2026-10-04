#!/usr/bin/env bash
# The fake Linear's TLS material for a bed: a throwaway CA and one certificate
# for Linear's three hosts, the fake's compose name and loopback, signed by it.
#
#   fake-linear/make-tls.sh <directory> [<another bed CA to trust> ...]
#
# Writes into <directory>: ca.pem (this CA), cert.pem and key.pem (what
# fake-linear serves), cas.pem (this CA and every other bed CA named, which
# this machine's Node processes and the backend's Node actions read through
# NODE_EXTRA_CA_CERTS) and bundle.pem (this machine's CA bundle with cas.pem
# appended, which the backend container reads through SSL_CERT_FILE, so it
# keeps trusting every public CA as well). Name fake-oidc's ca.pem when a bed
# runs both overlays: the last overlay's backend trust is the one that holds.
# The CA's key is deleted once it has signed: nothing else is ever signed by
# it. Never use any of it outside a bed.
set -euo pipefail

directory="${1:?usage: fake-linear/make-tls.sh <directory> [<another bed CA to trust> ...]}"
shift
system_bundle="${SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"

if [ ! -f "$system_bundle" ]; then
  echo "error: no CA bundle at $system_bundle; set SYSTEM_CA_BUNDLE to this machine's." >&2
  exit 2
fi
for extra in "$@"; do
  if [ ! -f "$extra" ]; then
    echo "error: no CA at $extra." >&2
    exit 2
  fi
done

mkdir -p "$directory"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=day0 fake-linear test CA" \
  -keyout "$work/ca-key.pem" -out "$directory/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=fake-linear" \
  -keyout "$directory/key.pem" -out "$work/cert.csr" 2>/dev/null
printf 'subjectAltName=DNS:api.linear.app,DNS:linear.app,DNS:mcp.linear.app,DNS:fake-linear,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' \
  > "$work/ext.cnf"
openssl x509 -req -in "$work/cert.csr" -CA "$directory/ca.pem" -CAkey "$work/ca-key.pem" \
  -CAcreateserial -CAserial "$work/ca.srl" -days 7 -extfile "$work/ext.cnf" -out "$directory/cert.pem" 2>/dev/null
cat "$directory/ca.pem" "$@" > "$directory/cas.pem"
cat "$system_bundle" "$directory/cas.pem" > "$directory/bundle.pem"
# Read by the fake's container user, which is not this one.
chmod 0644 "$directory/key.pem"
echo "wrote $directory/{ca,cas,cert,key,bundle}.pem for api.linear.app, linear.app and mcp.linear.app"
