#!/usr/bin/env bash
# The test issuer's TLS material for a bed: a throwaway CA and a certificate
# for the issuer's address, signed by it.
#
#   fake-oidc/make-tls.sh <directory> <issuer ip address>
#
# Writes into <directory>: ca.pem (what the app's server trusts through
# NODE_EXTRA_CA_CERTS), cert.pem and key.pem (what fake-oidc serves), and
# bundle.pem (this machine's CA bundle with ca.pem appended, which the backend
# container reads through SSL_CERT_FILE, so it keeps trusting every public CA
# as well). The CA's key is deleted once it has signed: nothing else is ever
# signed by it. Never use any of it outside a bed.
set -euo pipefail

directory="${1:?usage: fake-oidc/make-tls.sh <directory> <issuer ip address>}"
address="${2:?usage: fake-oidc/make-tls.sh <directory> <issuer ip address>}"
system_bundle="${SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"

if ! [[ "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "error: \"$address\" is not an IPv4 address." >&2
  exit 2
fi
if [ ! -f "$system_bundle" ]; then
  echo "error: no CA bundle at $system_bundle; set SYSTEM_CA_BUNDLE to this machine's." >&2
  exit 2
fi

mkdir -p "$directory"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=day0 fake-oidc test CA" \
  -keyout "$work/ca-key.pem" -out "$directory/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=fake-oidc" \
  -keyout "$directory/key.pem" -out "$work/cert.csr" 2>/dev/null
printf 'subjectAltName=IP:%s,DNS:fake-oidc\nextendedKeyUsage=serverAuth\n' "$address" > "$work/ext.cnf"
openssl x509 -req -in "$work/cert.csr" -CA "$directory/ca.pem" -CAkey "$work/ca-key.pem" \
  -CAcreateserial -CAserial "$work/ca.srl" -days 7 -extfile "$work/ext.cnf" -out "$directory/cert.pem" 2>/dev/null
cat "$system_bundle" "$directory/ca.pem" > "$directory/bundle.pem"
# Read by the fake's container user, which is not this one.
chmod 0644 "$directory/key.pem"
echo "wrote $directory/{ca,cert,key,bundle}.pem for https://$address"
