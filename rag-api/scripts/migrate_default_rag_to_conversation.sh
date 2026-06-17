#!/usr/bin/env bash
# Перенос индекса LightRAG из корня rag_storage в rag_storage/conv_<sanitized>
# (как rag_service._sanitize_conv_id в Python).
#
# Запуск внутри контейнера (после git pull и docker compose build rag-api):
#   docker compose exec rag-api bash /app/scripts/migrate_default_rag_to_conversation.sh 'conversations:u91txaqspahjqyjvyr6k'
#
# Или с хоста, если rag_storage смонтирован в ./data/rag:
#   RAG_STORAGE_ROOT=./data/rag bash rag-api/scripts/migrate_default_rag_to_conversation.sh 'conversations:...'

set -euo pipefail

ROOT="${RAG_STORAGE_ROOT:-./rag_storage}"
CONV_RAW="${1:?Usage: $0 <conversation_id>

  Example:
    $0 'conversations:u91txaqspahjqyjvyr6k'
}"

san="$(printf '%s' "$CONV_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [[ "$san" == *":"* ]]; then
  san="${san##*:}"
fi
san="$(printf '%s' "$san" | tr -c 'a-zA-Z0-9_\-' '_' | cut -c1-64)"
san="$(printf '%s' "$san" | sed 's/__*/_/g;s/^_//;s/_$//')"
if [[ -z "$san" ]]; then
  echo "error: empty sanitized conversation id"
  exit 1
fi

DEST="$ROOT/conv_$san"

if [[ ! -d "$ROOT" ]]; then
  echo "error: RAG storage root not found: $ROOT"
  exit 1
fi

if [[ -d "$DEST" ]] && [[ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]]; then
  echo "error: destination already exists and is not empty: $DEST"
  exit 1
fi

mkdir -p "$DEST"

moved=0
shopt -s nullglob dotglob
for path in "$ROOT"/*; do
  [[ -e "$path" ]] || continue
  base="$(basename "$path")"
  if [[ -d "$path" && "$base" == conv_* ]]; then
    continue
  fi
  if [[ -d "$path" ]]; then
    echo "warning: skipping unexpected directory (not conv_*): $path"
    continue
  fi
  mv "$path" "$DEST/"
  moved=$((moved + 1))
done

if [[ "$moved" -eq 0 ]]; then
  echo "nothing moved from $ROOT (no loose index files?)."
else
  echo "moved $moved entries from $ROOT -> $DEST"
fi
echo "target index directory: $DEST"
