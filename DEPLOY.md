# Запуск через Docker Compose

Предполагается установленный Docker и Docker Compose v2.

1. Скопируйте `.env.example` в `.env` и заполните секреты (`OPENROUTER_API_KEY`, при необходимости `GOOGLE_GENERATIVE_AI_API_KEY`).
2. В compose поднимается сервис **`ollama`**. После первого `up` подтяните модели **внутрь контейнера**:

```bash
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull qwen3:8b
docker compose exec ollama ollama pull qwen3:14b
# опционально: docker compose exec ollama ollama pull qwen3.6:27b
```

Без **`nomic-embed-text`** (или другой модели из `LOCAL_OPENAI_EMBEDDING_MODEL`) RAG падает на `/embeddings` с `APIConnectionError` / ретраями.

### Один проект chatbot2, а модели лежат в томе `chatbot_ollama_data`

По умолчанию Compose создаёт **отдельный** том вида `<имя_папки>_ollama_data` (например `foruschatbot2_ollama_data`) — это **не** тот же каталог, что у старого `chatbot`. В логах Ollama **`total blobs: 0`** как раз означает «смонтирован пустой том».

**Вариант 1 (удобно на сервере):** один раз скопировать override и дальше обычный `docker compose up`:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up -d --force-recreate ollama
docker compose exec ollama ollama list
```

**Вариант 2:** явно указать второй файл compose (ничего не «убирали» из репозитория — он в [`docker-compose.ollama-shared.yml`](docker-compose.ollama-shared.yml)):

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml up -d --force-recreate ollama
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml exec ollama ollama list
```

Если имя тома не `chatbot_ollama_data`, отредактируйте override или `docker-compose.ollama-shared.yml` под вывод `docker volume ls | grep ollama`.

Уберите из `.env` строку **`OLLAMA_BASE_URL=http://host.docker.internal:...`** для режима с контейнером `ollama`; нужно **`OLLAMA_BASE_URL=http://ollama:11434/v1`** (и то же для `OLLAMA_OPENAI_BASE_URL` у rag-api), иначе `web` ходит не в тот Ollama.

Не держите запущенными **два** контейнера `ollama` на **одном** томе.

### GPU (NVIDIA) для Ollama

В [`docker-compose.yml`](docker-compose.yml) у сервиса `ollama` задано **`gpus: all`** (все GPU в системе). Переменная **`NVIDIA_VISIBLE_DEVICES`** в `.env` позволяет ограничить карты, например `0` или `0,1` (индексы из `nvidia-smi`).

На хосте (Debian/Ubuntu) нужен **NVIDIA Driver** и **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)**. После установки перезапустите Docker:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Проверка, что контейнер видит GPU:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi
```

(Если образ `nvidia/cuda` не подтянется, используйте `nvidia/cuda:12.0-base-ubuntu22.04` или актуальный тег с Docker Hub.)

После `docker compose up -d` в логах `ollama` вместо одной строки `library=cpu` должны появиться устройства **CUDA** / **GPU**. Две карты (3070 + 3080): Ollama обычно грузит модель на одну выбранную по умолчанию; при необходимости смотрите [документацию Ollama](https://github.com/ollama/ollama/blob/main/docs/docker.md) по нескольким GPU.

### Длина контекста (`OLLAMA_CONTEXT_LENGTH`)

В [`docker-compose.yml`](docker-compose.yml) по умолчанию **131072 (128k)** — под **qwen3.5:9b** с полной расшифровкой в промпте. Ответы **медленнее**, зато реже `reason=length` и пустые сообщения.

**qwen3:14b** в Ollama обычно ограничен **~40960** (`n_ctx_train`); для 128k в чате выбирайте **qwen3.5:9b**. После смены `.env`: `docker compose up -d --force-recreate ollama web`.

### Почему `docker compose logs ollama -f` «не меняется» после правки `.env`

Переменные подхватываются **при старте контейнера**. Пока не выполните **`docker compose up -d --force-recreate ollama`**, в первой строке лога будет старый `OLLAMA_CONTEXT_LENGTH`. Убедитесь, что правите **тот** `.env`, из которого compose читает (каталог с `docker-compose.yml`).

### Отладка «тишины» и 500

- Временно: **`OLLAMA_DEBUG_LOG_REQUESTS=true`** в `.env` и пересоздайте `ollama` — Ollama пишет тела запросов во временный каталог (путь подскажет в логах при старте).
- Параллельно: **`docker compose logs web -f`**, **`docker stats`**, на хосте **`watch -n1 nvidia-smi`** — видно, грузятся ли GPU или всё ушло в CPU.
- В приложении для длинных ответов увеличен **`maxDuration`** у API чата (см. `app/api/chat/route.ts`).

### «Зависание» и строка `model requires more gpu memory… evicting`

Один процесс **Ollama** обслуживает и **чат** (Next → несколько запросов подряд: классификатор + стрим), и **RAG** (`rag-api` → эмбеддинги `nomic-embed-text`). Если в VRAM одновременно пытаются жить **две большие модели** (например 27B и 14B) или **27B + эмбеддинги**, сервер начинает **eviction** (`Operation:close`). На части сборок это выглядит как долгая пауза без новых логов и без текста на сайте.

В [`docker-compose.yml`](docker-compose.yml) для `ollama` задано **`OLLAMA_MAX_LOADED_MODELS=1`**: в памяти по сути одна полная загрузка LLM, остальные запросы ждут выгрузки — предсказуемее, чем «параллельно две модели». После `git pull` пересоздайте контейнер:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-shared.yml up -d --force-recreate ollama
```

Перед тестом чата можно остановить лишнюю нагрузку на тот же Ollama (например не гонять тяжёлый RAG в тот же момент). Для nginx при стриме см. выше: **`proxy_buffering off`**, большие **`proxy_read_timeout`**.

Если зависания останутся, временно проверьте **одну** видимую карту: `NVIDIA_VISIBLE_DEVICES=0` (только 3080) — проще схема размещения слоёв.

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

### Пользователи «не сохраняются» / повторная регистрация того же логина

Учётные записи лежат **только в SurrealDB** (таблица `users` в `SURREALDB_NAMESPACE` / `SURREALDB_DATABASE`), не в браузере. `localStorage` хранит лишь «кто вошёл» на этом устройстве.

**Частые причины:**

1. **Разные базы.** Регистрация с `npm run dev` на ПК при `SURREALDB_URL=ws://surrealdb:8000/rpc` не доходит до сервера (хост `surrealdb` существует только внутри Docker). Нужно `ws://127.0.0.1:8000/rpc` на хосте или вход через **тот же** URL, что у деплоя (`http://сервер:3000`).
2. **Разные тома Docker.** Том `<compose_project>_surreal-data` зависит от имени проекта (`COMPOSE_PROJECT_NAME` или имя папки). `chatbot_surreal-data` и `chatbot2_surreal-data` — **разные** БД. В SQL: `SELECT * FROM users` пусто — это нормально для нового тома.
3. **Пароль Surreal.** `SURREAL_ROOT_PASSWORD` у контейнера `surrealdb` и `SURREALDB_PASSWORD` у `web` должны совпадать.

**Проверка с сервера** (один и тот же инстанс, что использует `web`):

```bash
curl -s http://127.0.0.1:3000/api/health/db | jq .
```

Смотрите `surreal.namespace`, `surreal.database`, `userCount`. После регистрации `userCount` должен стать ≥ 1. С другого ПК откройте **тот же** сайт и снова вызовите `/api/health/db` — значения должны совпасть.

В Surreal CLI:

```bash
docker compose exec surrealdb /surreal sql \
  --endpoint ws://127.0.0.1:8000/rpc \
  --namespace chatbot --database main \
  --username root --password root
```

```sql
SELECT id, username, usernameLower FROM users;
```

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
