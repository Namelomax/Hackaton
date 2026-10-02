#!/usr/bin/env bash
# Сборка комплекта для переноса в закрытый контур (там нет доступа к npm,
# PyPI, HuggingFace и Docker Hub).
#
#   scripts/contour/bundle-images.sh [--with-rag] [--with-ollama]
#
# Результат — dist/protokoler-contour-<дата>-<коммит>/:
#   images.tar.gz          docker save всех нужных образов
#   docker-compose*.yml    файлы запуска
#   env.contour.example    шаблон .env
#   scripts/contour/       экспорт/импорт/бэкап БД
#   README.md              порядок установки
#   SHA256SUMS
#
# В контуре:  docker load -i images.tar.gz  →  дальше по README.md.
# Модели Ollama (если --with-ollama) в комплект НЕ входят — см. README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/contour/lib.sh

WITH_RAG=0
WITH_OLLAMA=0
for a in "$@"; do
  case "$a" in
    --with-rag) WITH_RAG=1 ;;
    --with-ollama) WITH_OLLAMA=1 ;;
    *) die "неизвестный аргумент: $a" ;;
  esac
done

require_docker
REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "⚠ в рабочей копии есть незакоммиченные изменения — они попадут в образ, а коммит $REV их не отражает"
fi
DIST="dist/protokoler-contour-$(date +%Y%m%d)-$REV"
mkdir -p "$DIST"

# Сборке compose нужны обязательные переменные из docker-compose.yml, но в
# образ они не попадают — подставляем заглушки, если .env здесь нет.
export SURREALDB_PASSWORD="${SURREALDB_PASSWORD:-build-only}"
export SESSION_SECRET="${SESSION_SECRET:-build-only}"

IMAGES=("${WEB_IMAGE:-protokoler-web:latest}" "$SURREAL_IMAGE")

info "сборка web"
docker compose build web

if [ "$WITH_RAG" = 1 ]; then
  info "сборка rag-api (с моделями MinerU — долго, образ несколько ГБ)"
  docker compose --profile rag build rag-api
  IMAGES+=("${RAG_IMAGE:-protokoler-rag:latest}")
fi

info "загрузка $SURREAL_IMAGE"
docker pull "$SURREAL_IMAGE"

if [ "$WITH_OLLAMA" = 1 ]; then
  OLLAMA_IMG="${OLLAMA_IMAGE:-ollama/ollama:latest}"
  docker pull "$OLLAMA_IMG"
  IMAGES+=("$OLLAMA_IMG")
fi

info "docker save: ${IMAGES[*]}"
docker save "${IMAGES[@]}" | gzip -1 >"$DIST/images.tar.gz"

cp docker-compose.yml docker-compose.gpu.yml "$DIST/"
cp deploy/contour/env.contour.example "$DIST/"
cp deploy/contour/README.md "$DIST/README.md"
mkdir -p "$DIST/scripts/contour"
cp scripts/contour/*.sh scripts/contour/*.mjs "$DIST/scripts/contour/"
chmod +x "$DIST/scripts/contour/"*.sh
printf '%s\n' "${IMAGES[@]}" >"$DIST/IMAGES.txt"
echo "$REV" >"$DIST/REVISION"

(cd "$DIST" && sha256sum images.tar.gz docker-compose.yml >SHA256SUMS)

echo "✓ комплект: $DIST ($(du -sh "$DIST" | cut -f1))"
echo "  образы: ${IMAGES[*]}"
