#!/usr/bin/env bash
# Резервная копия ЛОКАЛЬНОЙ SurrealDB (docker compose) с ротацией.
#
#   scripts/contour/db-backup.sh            # backups/local-<дата>.surql
#   BACKUP_KEEP=30 scripts/contour/db-backup.sh
#
# Для cron (ежедневно в 03:00):
#   0 3 * * * cd /opt/protokoler && scripts/contour/db-backup.sh >> backups/backup.log 2>&1
#
# В облаке бэкапы делал провайдер. После переезда это наша забота: без этого
# скрипта в cron потеря тома surreal-data = потеря всех протоколов.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/contour/lib.sh

KEEP="${BACKUP_KEEP:-14}"
PASS="$(env_get .env SURREALDB_PASSWORD)"
[ -n "$PASS" ] || die "в .env нет SURREALDB_PASSWORD"
NS="$(env_get .env SURREALDB_NAMESPACE)"; NS="${NS:-chatbot}"
DB="$(env_get .env SURREALDB_DATABASE)";  DB="${DB:-main}"

# Временный env-файл с подключением к БД внутри сети compose.
TMP_ENV="$(mktemp)"
chmod 600 "$TMP_ENV"
trap 'rm -f "$TMP_ENV"' EXIT
cat >"$TMP_ENV" <<EOF
SURREALDB_URL=ws://surrealdb:8000/rpc
SURREALDB_NAMESPACE=$NS
SURREALDB_DATABASE=$DB
SURREALDB_USER=root
SURREALDB_PASSWORD=$PASS
EOF

OUT="backups/local-$(date +%Y%m%d-%H%M%S).surql"
# Манифест для локального бэкапа не нужен: node на хосте контура может не быть.
AUTH_LEVEL=root scripts/contour/db-export.sh "$TMP_ENV" "$OUT" | grep -v '^⚠ нет node' || exit 1

# Ротация: оставляем KEEP последних.
ls -1t backups/local-*.surql 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "$old.counts.json"
  echo "  удалён старый бэкап: $old"
done
