#!/usr/bin/env bash
# Проверка ответа Ollama OpenAI API.
# think:false на /v1/chat/completions часто НЕ отключает reasoning — используйте reasoning_effort:none.

MODEL="${1:-qwen3.5:9b}"
HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

show_result() {
  python3 -c "import sys,json; j=json.load(sys.stdin); m=j['choices'][0]['message']; print('content:', repr((m.get('content') or '')[:200])); print('reasoning:', repr((m.get('reasoning') or '')[:80])); print('finish:', j['choices'][0].get('finish_reason'))"
}

echo "=== 1) think:false only (часто ломается на /v1) ==="
curl -sS "http://${HOST}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"think\":false,\"max_tokens\":128,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Привет одним коротким предложением на русском.\"}]}" \
  | show_result

echo ""
echo "=== 2) reasoning_effort:none (как в web после фикса) ==="
time curl -sS "http://${HOST}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"reasoning_effort\":\"none\",\"think\":false,\"max_tokens\":128,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Привет одним коротким предложением на русском.\"}]}" \
  | show_result

echo ""
echo "=== 3) native /api/chat think:false ==="
time curl -sS "http://${HOST}/api/chat" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"think\":false,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Привет одним коротким предложением на русском.\"}]}" \
  | python3 -c "import sys,json; j=json.load(sys.stdin); m=j.get('message',{}); print('content:', repr((m.get('content') or '')[:200])); print('thinking:', repr((m.get('thinking') or '')[:80]))"
