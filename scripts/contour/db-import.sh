#!/usr/bin/env bash
# Импорт дампа .surql в ЛОКАЛЬНУЮ SurrealDB из docker-compose.
#
#   scripts/contour/db-import.sh <файл.surql> [--force]
#
# Подключение к целевой БД — из .env (SURREALDB_NAMESPACE/DATABASE/PASSWORD).
# Импорт идёт в ПУСТУЮ базу: если в ней уже есть таблицы (например, web успел
# стартовать и создал схему), скрипт откажется — иначе определения таблиц из
# дампа конфликтуют с уже созданными. --force — импортировать всё равно.
#
# Порядок: остановить web → импорт → сверка (db-compare.mjs) → запустить web.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/contour/lib.sh

FILE="${1:-}"
FORCE="${2:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || die "укажите файл дампа: scripts/contour/db-import.sh backups/<файл>.surql"
require_docker

NS="$(env_get .env SURREALDB_NAMESPACE)"; NS="${NS:-chatbot}"
DB="$(env_get .env SURREALDB_DATABASE)";  DB="${DB:-main}"
PASS="$(env_get .env SURREALDB_PASSWORD)"
[ -n "$PASS" ] || die "в .env нет SURREALDB_PASSWORD (пароль root локальной БД)"

if [ -n "$(docker compose ps -q --status running web 2>/dev/null)" ]; then
  die "web запущен — остановите его на время импорта: docker compose stop web"
fi

info "поднимаю surrealdb"
docker compose up -d --wait surrealdb

run_surreal() {
  # `run` в сети compose: хост surrealdb виден, том БД не трогаем (--no-deps).
  docker compose run --rm --no-deps -T \
    -v "$(cd "$(dirname "$FILE")" && pwd):/backups:ro" \
    surrealdb "$@"
}

if [ "$FORCE" != "--force" ]; then
  INFO="$(echo 'INFO FOR DB;' | run_surreal sql --endpoint http://surrealdb:8000 \
    --username root --password "$PASS" --namespace "$NS" --database "$DB" --json --hide-welcome 2>&1 || true)"
  if echo "$INFO" | tr -d ' \n' | grep -q '"tables":{}'; then
    info "целевая база $NS/$DB пуста"
  elif echo "$INFO" | grep -q '"tables"'; then
    die "в $NS/$DB уже есть таблицы. Импорт — только в пустую базу (или --force). Ответ: $(echo "$INFO" | head -c 300)"
  else
    die "не удалось проверить целевую базу: $(echo "$INFO" | head -c 300)"
  fi
fi

info "импорт $FILE → $NS/$DB"
run_surreal import --endpoint http://surrealdb:8000 \
  --username root --password "$PASS" --namespace "$NS" --database "$DB" \
  "/backups/$(basename "$FILE")"

echo "✓ импорт завершён. Дальше:"
echo "  node scripts/contour/db-compare.mjs <env облака> .env   # сверить количество записей"
echo "  docker compose up -d web"
