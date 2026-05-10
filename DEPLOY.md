# Запуск через Docker Compose

Предполагается установленный Docker и Docker Compose v2.

1. Скопируйте `.env.example` в `.env` и заполните секреты (`OPENROUTER_API_KEY`, при необходимости `GOOGLE_GENERATIVE_AI_API_KEY`).
2. На машине с GPU или достаточным RAM запустите **Ollama** на хосте и подтяните модели (`ollama pull qwen3:14b`, `ollama pull qwen3.6:27b`, `ollama pull nomic-embed-text`).
3. Из корня репозитория:

```bash
docker compose up -d --build
```

4. Откройте приложение: `http://localhost:3000` (или порт из `WEB_PORT`).
5. SurrealDB слушает порт `8000` на хосте по умолчанию (`SURREAL_PORT`). Данные лежат в volume `surreal-data`.
6. RAG API доступен с хоста на порту `8001` по умолчанию (`RAG_API_PORT`); внутри сети compose приложение ходит на `http://rag-api:8000`.

На Linux для доступа контейнеров к Ollama на хосте используется `extra_hosts: host.docker.internal:host-gateway`. При необходимости замените `OLLAMA_BASE_URL` / `OLLAMA_OPENAI_BASE_URL` на IP хоста.

### SurrealDB: версия движка и npm-клиент

Образ по умолчанию — **SurrealDB 2.6.x** (`SURREALDB_IMAGE` в compose). Пакет `surrealdb` в приложении (ветка 1.x) ожидает движок **`>= 1.4.2 < 3.0.0`**. Если поднять сервер **3.x** (`:latest`), в логах web появится `UnsupportedVersion`.

Чтобы позже использовать SurrealDB 3, нужно обновить зависимость `surrealdb` в `package.json` до версии с поддержкой 3.x и пересобрать образ `web`.

### SurrealDB: `Permission denied` / RocksDB

Если `docker compose logs surrealdb` показывает `Failed to create RocksDB directory` / `Permission denied`, в `docker-compose.yml` для сервиса `surrealdb` задано `user: "0:0"`. Подтяните изменения и пересоздайте контейнер:

```bash
docker compose up -d --force-recreate surrealdb
```

Если volume уже создан с «чужими» правами и ошибка остаётся, удалите только том Surreal (**потеря данных этой БД**):

```bash
docker compose down
docker volume rm ИМЯПРОЕКТА_surreal-data
docker compose up -d
```

---

## Локальная разработка без Docker

- Запустите SurrealDB, rag-api (`uvicorn`) и Next (`npm run dev`) отдельно.
- Укажите `SURREALDB_URL`, `RAG_API_URL`, `OLLAMA_BASE_URL` на адреса ваших сервисов на localhost.
