#!/usr/bin/env bash
# Быстрая проверка скорости Ollama на хосте (или из контейнера web).
# Использование:
#   ./scripts/benchmark-ollama.sh
#   ./scripts/benchmark-ollama.sh qwen3.5:9b
#   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 ./scripts/benchmark-ollama.sh

set -euo pipefail

MODEL="${1:-qwen3.5:9b}"
BASE="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
MAX_TOKENS="${2:-256}"

echo "=== Ollama benchmark ==="
echo "URL:        $BASE"
echo "Model:      $MODEL"
echo "max_tokens: $MAX_TOKENS"
echo ""

payload=$(cat <<EOF
{
  "model": "$MODEL",
  "max_tokens": $MAX_TOKENS,
  "temperature": 0.7,
  "stream": false,
  "messages": [
    {"role": "user", "content": "Ответь одним коротким предложением на русском: привет."}
  ]
}
EOF
)

echo "--- Short prompt (warm / hot) ---"
START=$(date +%s.%N)
curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$payload" \
  -o /tmp/ollama-bench-out.json
END=$(date +%s.%N)
ELAPSED=$(awk "BEGIN {print $END - $START}")
echo "Wall time: ${ELAPSED}s"
python3 - <<'PY' 2>/dev/null || cat /tmp/ollama-bench-out.json | head -c 400
import json
with open("/tmp/ollama-bench-out.json") as f:
    j = json.load(f)
c = j.get("choices", [{}])[0].get("message", {}).get("content", "")
usage = j.get("usage", {})
print("Reply:", (c or "")[:200])
print("Usage:", usage)
PY
echo ""

echo "--- Tip: follow live requests ---"
echo "  docker compose logs ollama -f"
echo "  docker compose logs web -f | grep -E 'streamText|step done|⏳|📐'"
