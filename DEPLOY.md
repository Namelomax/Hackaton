# Запуск через Docker Compose

Предполагается установленный Docker и Docker Compose v2.

1. Скопируйте `.env.example` в `.env` и заполните секреты (`OPENROUTER_API_KEY`, при необходимости `GOOGLE_GENERATIVE_AI_API_KEY`).
2. В compose поднимается сервис **`ollama`**. После первого `up` подтяните модели **внутрь контейнера**:

```bash
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull qwen3:14b
docker compose exec ollama ollama pull qwen3.6:27b
```

Без **`nomic-embed-text`** (или другой модели из `LOCAL_OPENAI_EMBEDDING_MODEL`) RAG падает на `/embeddings` с `APIConnectionError` / ретраями.

Переиспользование моделей из старого проекта: тома `chatbot_ollama_data` и `chatbot2_ollama_data` — **разные каталоги**. Переменная `OLLAMA_VOLUME_NAME` в имени тома в Compose на части установок **не подставляется** — контейнер остаётся на пустом томе.

Надёжный способ: второй файл compose с **внешним** томом (отредактируйте имя тома в файле под вывод `docker volume ls`):

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml up -d --force-recreate ollama
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml exec ollama ollama list
```

Уберите из `.env` строку **`OLLAMA_BASE_URL=http://host.docker.internal:...`** для режима с контейнером `ollama`; нужно **`OLLAMA_BASE_URL=http://ollama:11434/v1`** (и то же для `OLLAMA_OPENAI_BASE_URL` у rag-api), иначе `web` ходит не в тот Ollama.

Не держите запущенными **два** контейнера `ollama` на **одном** томе.

GPU (NVIDIA): в `docker-compose.yml` у сервиса `ollama` можно добавить блок `deploy.resources.reservations.devices` или устаревшее `gpus: all` (как в старом RagTest) — см. [документацию Ollama Docker](https://github.com/ollama/ollama/blob/main/docs/docker.md).

Если Ollama должен остаться **только на хосте**, уберите сервис `ollama` из compose (или не используйте этот файл) и в `.env` задайте `OLLAMA_OPENAI_BASE_URL` и `OLLAMA_BASE_URL` на `http://IP_ХОСТА:11434/v1` (на Linux `host.docker.internal` часто не подходит без `extra_hosts`).
3. Из корня репозитория:

```bash
docker compose up -d --build
```

4. Откройте приложение: `http://localhost:3000` (или порт из `WEB_PORT`).
5. SurrealDB слушает порт `8000` на хосте по умолчанию (`SURREAL_PORT`). Данные лежат в volume `surreal-data`.
6. RAG API доступен с хоста на порту `8001` по умолчанию (`RAG_API_PORT`); внутри сети compose приложение ходит на `http://rag-api:8000`.

### RAG: дубликат документа / «No new unique documents»

Повторная загрузка того же PDF даёт `Duplicate document` — индекс уже содержит этот `doc-…`. Либо загрузите другой файл, либо сбросьте индекс (удаление тома **`rag-storage`**, это сотрёт весь RAG-корпус):

```bash
docker compose down
docker volume rm ИМЯПРОЕКТА_rag-storage
docker compose up -d
```

Предупреждения про multimodal / «Missing required fields» связаны с тем, что в `rag-api` для LightRAG частично используется упрощённая LLM-заглушка; на работу поиска после успешных эмбеддингов это обычно не критично.

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

### После смены major-версии SurrealDB (3 → 2 или наоборот)

Если в логах surrealdb: **«The data stored on disk is out-of-date with this version»**, том был создан другой major-версией движка. Либо удалите том и начните с чистой БД (см. выше), либо верните тот же major, что создавал данные, и мигрируйте по [официальным upgrade guides](https://surrealdb.com/docs).

---

## Локальная разработка без Docker

- Запустите SurrealDB, rag-api (`uvicorn`) и Next (`npm run dev`) отдельно.
- Укажите `SURREALDB_URL`, `RAG_API_URL`, `OLLAMA_BASE_URL` на адреса ваших сервисов на localhost.
