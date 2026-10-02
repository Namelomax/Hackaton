#!/usr/bin/env bash
# Экспорт базы SurrealDB (облачной или локальной) в файл .surql.
#
#   scripts/contour/db-export.sh [env-файл] [выходной-файл]
#
#   env-файл — откуда брать подключение (по умолчанию .env). Понимает и
#              SURREALDB_*, и SURREAL_* (облачный шаблон).
#   AUTH_LEVEL=root|namespace|database — уровень пользователя БД. По умолчанию
#              root — так же входит приложение (lib/getPromt.ts: signin без
#              namespace), значит пользователь из .env root-уровня.
#
# Только ЧИТАЕТ базу-источник. Дамп содержит ПДн (расшифровки, протоколы) и
# таблицу соответствий анонимизации с настоящими ФИО: права 600, хранить в
# контуре, удалить после переноса.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/contour/lib.sh

ENV_FILE="${1:-.env}"
OUT="${2:-backups/protokoler-$(date +%Y%m%d-%H%M%S).surql}"
AUTH_LEVEL="${AUTH_LEVEL:-root}"

require_docker
[ -f "$ENV_FILE" ] || die "нет файла $ENV_FILE"
load_surreal_env "$ENV_FILE"
[ -n "$DB_URL" ] && [ -n "$DB_NS" ] && [ -n "$DB_DB" ] && [ -n "$DB_USER" ] && [ -n "$DB_PASS" ] \
  || die "в $ENV_FILE не хватает SURREALDB_URL/NAMESPACE/DATABASE/USER/PASSWORD (или SURREAL_*)"

ENDPOINT="$(http_endpoint "$DB_URL")"
NETWORK="$(docker_network_for "$DB_URL")"
[ "$NETWORK" = "host" ] && ENDPOINT="$(echo "$ENDPOINT" | sed -E 's#//localhost#//127.0.0.1#')"

mkdir -p "$(dirname "$OUT")"
umask 077
OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)"
OUT_NAME="$(basename "$OUT")"

info "источник: $ENDPOINT ns=$DB_NS db=$DB_DB user=$DB_USER (auth-level=$AUTH_LEVEL)"
info "файл:     $OUT_DIR/$OUT_NAME"

docker run --rm --network "$NETWORK" --user "$(id -u):$(id -g)" \
  -v "$OUT_DIR:/backups" \
  "$SURREAL_IMAGE" export \
  --endpoint "$ENDPOINT" \
  --username "$DB_USER" --password "$DB_PASS" --auth-level "$AUTH_LEVEL" \
  --namespace "$DB_NS" --database "$DB_DB" \
  "/backups/$OUT_NAME"

[ -s "$OUT_DIR/$OUT_NAME" ] || die "дамп пустой — проверьте доступ и AUTH_LEVEL"
chmod 600 "$OUT_DIR/$OUT_NAME"
echo "✓ экспорт готов: $OUT_DIR/$OUT_NAME ($(du -h "$OUT_DIR/$OUT_NAME" | cut -f1))"

# Манифест количеств — чтобы в контуре сверить импорт без доступа к источнику.
# Права 644: в нём только числа, а читает его контейнер web (uid 1001).
# Снимается сразу после экспорта: если в базу пишут, числа разойдутся, поэтому
# переносить данные нужно при остановленной записи (см. deploy/contour/README.md).
if command -v node >/dev/null 2>&1 && [ -d node_modules/surrealdb ]; then
  node scripts/contour/db-counts.mjs --env "$ENV_FILE" --out "$OUT_DIR/$OUT_NAME.counts.json" >/dev/null \
    && chmod 644 "$OUT_DIR/$OUT_NAME.counts.json" \
    && echo "✓ манифест: $OUT_DIR/$OUT_NAME.counts.json" \
    || echo "⚠ манифест не снят — сверьте вручную: node scripts/contour/db-counts.mjs --env $ENV_FILE"
else
  echo "⚠ нет node/node_modules — манифест не снят. Выполните: node scripts/contour/db-counts.mjs --env $ENV_FILE --out $OUT.counts.json"
fi
echo "  ⚠ в файле ПДн — не коммитить, не пересылать открытыми каналами, удалить после импорта."
