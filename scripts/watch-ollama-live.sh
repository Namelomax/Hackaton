#!/usr/bin/env bash
# «Как LM Studio» в терминале: что сейчас делает Ollama + GPU.
# Запуск: ./scripts/watch-ollama-live.sh

set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
INTERVAL="${1:-2}"

has_nvidia() {
  command -v nvidia-smi >/dev/null 2>&1
}

while true; do
  clear
  echo "=== Ollama live @ ${OLLAMA_HOST} === $(date '+%H:%M:%S') ==="
  echo ""

  echo "--- Running models (ollama ps) ---"
  curl -sS "http://${OLLAMA_HOST}/api/ps" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "(no response)"
  echo ""

  if has_nvidia; then
    echo "--- GPU (nvidia-smi) ---"
    nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null || true
    echo ""
  fi

  echo "--- Web agent (last 8 lines) ---"
  docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" logs web --tail=8 2>/dev/null \
    | grep -E '📨|📐|🤖|⏳|step done|agent done|⚠️' || echo "(no matching lines — is web running?)"
  echo ""
  echo "Refresh every ${INTERVAL}s — Ctrl+C to stop"
  sleep "$INTERVAL"
done
