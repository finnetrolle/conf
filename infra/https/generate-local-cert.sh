#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${SCRIPT_DIR}/certs"
CERT_FILE="${CERT_DIR}/dev-cert.pem"
KEY_FILE="${CERT_DIR}/dev-key.pem"
OPENSSL_BIN="${OPENSSL_BIN:-$(command -v openssl || true)}"

if [ -z "${OPENSSL_BIN}" ]; then
  echo "openssl not found in PATH. Install OpenSSL or set OPENSSL_BIN=/path/to/openssl." >&2
  exit 1
fi

mkdir -p "${CERT_DIR}"

HOSTS=("$@")
if [ ${#HOSTS[@]} -eq 0 ]; then
  HOSTS=("localhost" "127.0.0.1")
fi

TMP_CONFIG="$(mktemp)"
trap 'rm -f "${TMP_CONFIG}"' EXIT

{
  echo "[req]"
  echo "default_bits = 2048"
  echo "prompt = no"
  echo "default_md = sha256"
  echo "x509_extensions = v3_req"
  echo "distinguished_name = dn"
  echo
  echo "[dn]"
  echo "CN = ${HOSTS[0]}"
  echo
  echo "[v3_req]"
  echo "subjectAltName = @alt_names"
  echo "extendedKeyUsage = serverAuth"
  echo "keyUsage = digitalSignature, keyEncipherment"
  echo
  echo "[alt_names]"

  dns_index=1
  ip_index=1
  for host in "${HOSTS[@]}"; do
    if [[ "${host}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      echo "IP.${ip_index} = ${host}"
      ip_index=$((ip_index + 1))
    else
      echo "DNS.${dns_index} = ${host}"
      dns_index=$((dns_index + 1))
    fi
  done
} > "${TMP_CONFIG}"

"${OPENSSL_BIN}" req \
  -x509 \
  -nodes \
  -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -days 365 \
  -config "${TMP_CONFIG}"

echo "Generated certificate:"
echo "  cert: ${CERT_FILE}"
echo "  key:  ${KEY_FILE}"
echo
echo "Hosts/IPs in SAN:"
for host in "${HOSTS[@]}"; do
  echo "  - ${host}"
done
