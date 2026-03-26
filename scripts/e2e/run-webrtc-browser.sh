#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-webrtc_e2e}"
TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP:-127.0.0.1}"
PUBLIC_APP_URL="${PUBLIC_APP_URL:-https://127.0.0.1:3000}"
API_PORT="${API_PORT:-8080}"
TURN_PORT="${TURN_PORT:-3478}"

wait_for_http() {
  local name="$1"
  local url="$2"
  local max_attempts="${3:-60}"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if curl -fsSk "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ${name} at ${url}" >&2
  return 1
}

wait_for_tcp() {
  local name="$1"
  local host="$2"
  local port="$3"
  local max_attempts="${4:-60}"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if (echo >/dev/tcp/"${host}"/"${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ${name} on ${host}:${port}" >&2
  return 1
}

cleanup() {
  (
    cd "${ROOT_DIR}" &&
      COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME}" \
      PUBLIC_APP_URL="${PUBLIC_APP_URL}" \
      TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP}" \
      docker compose down -v >/dev/null 2>&1
  ) || true
}

trap cleanup EXIT

cd "${ROOT_DIR}"

./infra/https/generate-local-cert.sh localhost 127.0.0.1 web >/dev/null
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME}" \
  PUBLIC_APP_URL="${PUBLIC_APP_URL}" \
  TURN_EXTERNAL_IP="${TURN_EXTERNAL_IP}" \
  docker compose up -d --build web server coturn

wait_for_http "server health" "http://127.0.0.1:${API_PORT}/health"
wait_for_http "web app" "${PUBLIC_APP_URL}"
wait_for_tcp "coturn" "127.0.0.1" "${TURN_PORT}"

(
  cd "${ROOT_DIR}/apps/web"
  E2E_BASE_URL="${PUBLIC_APP_URL}" node e2e/webrtc-browser.mjs
)
