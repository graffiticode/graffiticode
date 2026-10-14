#!/bin/bash
# ISOLATE-01: the egress proxy's private CA and its per-host certificates.
# Local files only; nothing is uploaded. Runbook: README.md, "Certificates".
#
#   deploy/egress-proxy/issue-certs.sh ca <ca-dir>
#       Create the CA once (EC P-256, 10 years) on an offline machine:
#       <ca-dir>/ca.key (keep offline) and <ca-dir>/ca.crt (the public bundle).
#   deploy/egress-proxy/issue-certs.sh issue <ca-dir> <out-dir> <host>...
#       One certificate per terminated host (397 days), written as
#       <out-dir>/<host-with-dashes>.pem holding the certificate and its key,
#       the payload of the egress-proxy-cert-<host-with-dashes> secret.
#       The hosts are what `node deploy/egress-proxy/generate.js` lists.
set -euo pipefail
umask 077

usage() { sed -n '4,12p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage

case "$1" in
  ca)
    dir=$2
    [ ! -e "$dir/ca.key" ] || { echo "$dir/ca.key exists; the CA is created once" >&2; exit 1; }
    mkdir -p "$dir"
    openssl ecparam -name prime256v1 -genkey -noout -out "$dir/ca.key"
    openssl req -x509 -new -key "$dir/ca.key" -sha256 -days 3650 -subj "/O=Graffiticode/CN=Graffiticode compiler egress CA" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -addext "nameConstraints=critical,permitted;DNS:.run.app,permitted;DNS:.googleapis.com" \
      -out "$dir/ca.crt"
    chmod 444 "$dir/ca.crt"
    echo "created $dir/ca.key (keep offline) and $dir/ca.crt"
    ;;
  issue)
    [ $# -ge 4 ] || usage
    ca=$2; out=$3; shift 3
    mkdir -p "$out"
    for host in "$@"; do
      [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "not a hostname: $host" >&2; exit 1; }
      name=${host//./-}
      work=$(mktemp -d)
      openssl ecparam -name prime256v1 -genkey -noout -out "$work/key.pem"
      openssl req -new -key "$work/key.pem" -subj "/CN=$host" -out "$work/req.csr"
      printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$host" > "$work/ext.cnf"
      openssl x509 -req -in "$work/req.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" -CAcreateserial -days 397 -sha256 \
        -extfile "$work/ext.cnf" -out "$work/cert.pem"
      cat "$work/cert.pem" "$work/key.pem" > "$out/$name.pem"
      rm -rf "$work"
      echo "issued $out/$name.pem for $host"
    done
    ;;
  *) usage ;;
esac
