#!/usr/bin/env bash
# Общие функции скриптов scripts/contour/*. Подключается через `source`.

SURREAL_IMAGE="${SURREALDB_IMAGE:-surrealdb/surrealdb:v2.6.5}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forus-chatbot}"

die() { echo "✗ $*" >&2; exit 1; }
info() { echo "→ $*"; }

# Значение ключа из env-файла без source (в .env бывают строки, которые shell
# не переварит). Берётся последнее вхождение; кавычки вокруг снимаются.
env_get() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^[[:space:]]*${key}=" "$file" | tail -n1 | sed -E "s/^[[:space:]]*${key}=//; s/^['\"]//; s/['\"][[:space:]]*$//"
}

# Параметры подключения к SurrealDB из env-файла: SURREALDB_* приоритетнее
# SURREAL_* — ровно как в приложении (lib/surreal-env.ts).
load_surreal_env() {
  local file="$1"
  DB_URL="$(env_get "$file" SURREALDB_URL)";        [ -n "$DB_URL" ]  || DB_URL="$(env_get "$file" SURREAL_URL)"
  DB_NS="$(env_get "$file" SURREALDB_NAMESPACE)";   [ -n "$DB_NS" ]   || DB_NS="$(env_get "$file" SURREAL_NAMESPACE)"
  DB_DB="$(env_get "$file" SURREALDB_DATABASE)";    [ -n "$DB_DB" ]   || DB_DB="$(env_get "$file" SURREAL_DATABASE)"
  DB_USER="$(env_get "$file" SURREALDB_USER)";      [ -n "$DB_USER" ] || DB_USER="$(env_get "$file" SURREAL_USER)"
  DB_PASS="$(env_get "$file" SURREALDB_PASSWORD)"
  [ -n "$DB_PASS" ] || DB_PASS="$(env_get "$file" SURREAL_PASSWORD)"
  [ -n "$DB_PASS" ] || DB_PASS="$(env_get "$file" SURREAL_PASS)"
}

# ws(s)://host[:port]/rpc → http(s)://host[:port] — CLI export/import ходит по HTTP.
http_endpoint() {
  echo "$1" | sed -E 's#^ws://#http://#; s#^wss://#https://#; s#/rpc/?$##; s#/$##'
}

# Сеть для `docker run`: хост `surrealdb` резолвится только внутри сети compose,
# 127.0.0.1/localhost — только в сети хоста, остальное (облако) — из любой.
docker_network_for() {
  local host
  host="$(echo "$1" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  case "$host" in
    surrealdb) echo "${PROJECT_NAME}_default" ;;
    127.0.0.1|localhost) echo "host" ;;
    *) echo "bridge" ;;
  esac
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "нужен docker"
  docker info >/dev/null 2>&1 || die "docker недоступен (демон не запущен или нет прав)"
}
