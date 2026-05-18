#!/usr/bin/env bash
# Проверка ответа с think:false (как в приложении).
# Без think:false Qwen3.5 часто кладёт всё в reasoning, content пустой.

MODEL="${1:-qwen3.5:9b}"
HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

echo "=== stream=false think=false ==="
time curl -sS "http://${HOST}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"think\":false,\"max_tokens\":128,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Привет одним коротким предложением на русском.\"}]}" \
  | python3 -c "import sys,json; j=json.load(sys.stdin); m=j['choices'][0]['message']; print('content:', repr((m.get('content') or '')[:200])); print('reasoning:', repr((m.get('reasoning') or '')[:120]))"

echo ""
echo "=== stream=true think=false (как в чате) ==="
curl -sS -N "http://${HOST}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${MODEL}\",\"think\":false,\"max_tokens\":64,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Скажи: ок.\"}]}" \
  | while read -r line; do
      case "$line" in
        data:\ *) echo "${line#data: }" | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('choices',[{}])[0]; dlt=c.get('delta',{}); t=dlt.get('content') or dlt.get('reasoning') or ''; print(t,end='',flush=True)" 2>/dev/null || true ;;
      esac
    done
echo ""
