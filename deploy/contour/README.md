# Переезд Протоколера в контур компании

Цель: тот же Протоколер, но целиком внутри контура. Приложение, база и модели
работают на серверах компании, данные наружу не уходят.

Текущий облачный прод (systemd + Surreal Cloud, `deploy/DEPLOY-PROTOKOLER.md`)
работает как раньше, пока вы не переключите пользователей. Всё, что описано
ниже, можно готовить и репетировать параллельно, прод при этом не трогается.

## Что входит в установку

| Сервис | Нужен | Что делает |
|---|---|---|
| `web` | всегда | Next.js-приложение, порт 3000 |
| `surrealdb` | всегда | локальная БД вместо Surreal Cloud (та же версия 2.6.5) |
| `rag-api` | профиль `rag` | источники проектных папок, RAG по документам |
| `ollama` | профиль `ollama` | только если у компании нет своего LLM-сервера |

Облачного режима и анонимизатора больше нет (убраны 02.10.2026): протоколы
готовит только локальная модель, так что внешних сервисов, кроме LLM-сервера
компании, установке не нужно.

## Решить до переезда

1. **LLM.** Где будет крутиться модель: на сервере компании (vLLM, Ollama,
   шлюз) или в нашем контейнере `ollama` (нужна GPU). Текущий прод ходит во
   внешний шлюз `oui.interfonica.cloud`, в контуре его не будет.
2. **Сервер.** Linux, Docker Engine 24+ и Compose v2. Для `ollama` нужны
   NVIDIA Driver и Container Toolkit.
3. **Интернет в контуре.** Если его нет, образы собираются снаружи и
   переносятся файлом (шаг 1). Модели Ollama тоже переносятся отдельно.
4. **Домен и TLS.** Reverse-proxy компании (nginx и т.п.) → `127.0.0.1:3000`,
   с `proxy_buffering off` (протокол стримится по SSE) и
   `client_max_body_size 50m`.

## 1. Снаружи: собрать комплект

На машине с интернетом и Docker, из корня репозитория:

```bash
scripts/contour/bundle-images.sh                  # web + surrealdb
scripts/contour/bundle-images.sh --with-rag       # + rag-api (несколько ГБ: MinerU, LibreOffice)
scripts/contour/bundle-images.sh --with-rag --with-ollama
```

Получится `dist/protokoler-contour-<дата>-<коммит>/`: образы, compose-файлы,
шаблон `.env`, скрипты и эта инструкция. Каталог целиком переносится в контур.

Модели Ollama в комплект не входят: их скачивают снаружи (`ollama pull`) и
переносят каталог моделей (`~/.ollama/models` или том `ollama-data`) отдельно.

## 2. В контуре: первый запуск

```bash
cd /opt/protokoler                         # куда распаковали комплект
sha256sum -c SHA256SUMS
docker load -i images.tar.gz
cp env.contour.example .env && nano .env   # SURREALDB_PASSWORD, SESSION_SECRET, ADMIN_USERNAMES, LLM
docker compose up -d surrealdb             # только БД: если будете переносить данные — сначала шаг 3
```

Свежая установка без переноса данных:

```bash
docker compose up -d                       # + --profile rag / --profile ollama при необходимости
curl -s http://127.0.0.1:3000/api/health/db
```

Откройте сайт, нажмите «Первый вход администратора» и зарегистрируйте логин
из `ADMIN_USERNAMES`. Остальных пользователей заводите на `/admin`.

## 3. Перенос данных из облака

Переносятся пользователи, чаты, протоколы, промпты и папки (таблица
`anonymization_mappings` тоже: в ней лежат JSON протоколов для точечных правок
и соответствия имён для старых протоколов). Индексов RAG в облачной версии нет (`RAG_API_URL` на проде не
задан), так что переносить там нечего.

**Репетиция** — сколько угодно раз, прод не трогается (экспорт только читает):

```bash
# снаружи, из репозитория, с .env облачного прода:
scripts/contour/db-export.sh .env           # → backups/protokoler-<время>.surql (+ .counts.json)
```

Дамп вместе с манифестом переносится в контур, в каталог `backups/` установки.
Затем:

```bash
docker compose stop web
scripts/contour/db-import.sh backups/protokoler-<время>.surql
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/backups:/backups:ro" \
  web node scripts/contour/db-counts.mjs --expect /backups/protokoler-<время>.surql.counts.json
docker compose up -d web
```

`db-import.sh` импортирует только в пустую базу. Чтобы повторить репетицию,
удалите том: `docker compose down && docker volume rm forus-chatbot_surreal-data`.

**⚠ В дампе ПДн**: расшифровки, протоколы и таблица `anonymization_mappings`
с настоящими ФИО. Права на файл — 600. Не пересылать открытыми каналами
(почта, мессенджеры), после импорта удалить с промежуточных машин.

## 4. День переключения

1. Предупредить пользователей и остановить работу на облачном проде:
   `systemctl --user stop protokoler`. Всё, что запишут после экспорта,
   в контур не попадёт.
2. Финальный экспорт (`db-export.sh`), перенос, импорт и сверка, как в шаге 3.
   Сверка должна показать «все N таблиц совпали».
3. `docker compose up -d`, проверить вход, список чатов, открыть пару протоколов,
   скачать DOCX.
4. Переключить пользователей на адрес в контуре.

**Откат:** облачная база в процессе не меняется. Если что-то пошло не так,
снова запустите прод (`systemctl --user start protokoler`), и всё вернётся как было.

## 5. После переезда: бэкапы

В облаке бэкапы делал провайдер, теперь это наша задача:

```bash
crontab -e
0 3 * * * cd /opt/protokoler && scripts/contour/db-backup.sh >> backups/backup.log 2>&1
```

Скрипт хранит 14 последних копий (`BACKUP_KEEP=30` — больше). Копии стоит
регулярно выносить на другой диск или сервер: бэкап на том же диске не
спасёт от потери диска.

Тома с данными: `forus-chatbot_surreal-data` (БД), `forus-chatbot_rag-storage`
и `forus-chatbot_rag-uploads` (RAG). Имя проекта (`COMPOSE_PROJECT_NAME`)
на живой установке не меняйте: новое имя создаёт новые пустые тома.

## Обновление версии

Снаружи: `git pull && scripts/contour/bundle-images.sh [--with-rag]`. В контуре:

```bash
scripts/contour/db-backup.sh
docker load -i images.tar.gz
docker compose up -d                        # пересоздаст контейнеры с новыми образами
```

Схема БД обновляется сама при старте (`DEFINE … IF NOT EXISTS`).

## Неполадки

- **web не стартует, «Задайте SURREALDB_PASSWORD/SESSION_SECRET»**: не заполнен `.env`.
- **`/api/health/db` → 500**: `docker compose logs surrealdb`. Пароль в `.env`
  должен совпадать с тем, с которым БД создавалась при первом запуске.
- **Ответы модели не приходят**: проверьте изнутри контейнера
  `docker compose exec web node -e "fetch(process.env.OLLAMA_BASE_URL+'/models').then(r=>r.text()).then(console.log)"`.
  Если шлюз отвечает JSON на `stream:true`, нужно `LLM_FORCE_NONSTREAM=true`.
- **RAG/MinerU лезет в интернет**: образ rag-api собран без
  `PRELOAD_MINERU_MODELS=1`. Пересоберите комплект с `--with-rag`.
- **GPU не видна Ollama**:
  `docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile ollama up -d`.

### Пользователи «не сохраняются», логин приходится регистрировать заново

Учётные записи лежат только в SurrealDB (таблица `users`), не в браузере:
`localStorage` помнит лишь, кто вошёл на этом устройстве. Почти всегда это
значит, что приложение смотрит не в ту базу, в которую вы думаете.

1. **Не тот адрес БД.** Хост `surrealdb` существует только внутри Docker. Если
   запустить `npm run dev` на хосте с `SURREALDB_URL=ws://surrealdb:8000/rpc`,
   до этой БД он не достучится. На хосте — `ws://127.0.0.1:8000/rpc`.
2. **Не тот том.** Том называется `<имя проекта>_surreal-data`, по умолчанию
   `forus-chatbot_surreal-data`. Сменили `COMPOSE_PROJECT_NAME` или каталог —
   получили новую пустую базу.

Проверка — тот же экземпляр, что использует `web`:

```bash
curl -s http://127.0.0.1:3000/api/health/db
```

Смотрите `surreal.namespace`, `surreal.database` и `userCount`. После
регистрации `userCount` должен стать ≥ 1. С другого компьютера откройте тот же
сайт и вызовите `/api/health/db` ещё раз — значения должны совпасть.

Напрямую в БД. Пароль берётся из `.env` — в оболочке хоста переменной
`SURREALDB_PASSWORD` нет, пока вы её сами не загрузите:

```bash
PASS=$(grep '^SURREALDB_PASSWORD=' .env | cut -d= -f2)
docker compose exec surrealdb /surreal sql \
  --endpoint ws://127.0.0.1:8000/rpc \
  --namespace chatbot --database main \
  --username root --password "$PASS"
```

```sql
SELECT id, username, usernameLower FROM users;
```

### SurrealDB: версия движка

Движок — SurrealDB **2.6.x**. npm-клиент `surrealdb` в приложении (ветка 1.x)
работает только с движком `>= 1.4.2 < 3.0.0`. Если поднять 3.x (`:latest`), в
логах `web` появится `UnsupportedVersion`. Переход на 3.x требует обновить
зависимость `surrealdb` в `package.json` и пересобрать образ `web`.

**«The data stored on disk is out-of-date with this version»** — том создан
другой major-версией движка. Верните ту версию, что создавала данные, и
мигрируйте по [руководствам SurrealDB](https://surrealdb.com/docs), либо
начните с чистой базы (см. ниже).

### SurrealDB: `Permission denied` / RocksDB

`Failed to create RocksDB directory` в `docker compose logs surrealdb`. В
`docker-compose.yml` для `surrealdb` уже задано `user: "0:0"`, поэтому чаще всего
дело в томе, созданном раньше с чужими правами. Сначала:

```bash
docker compose up -d --force-recreate surrealdb
```

Не помогло — удалите том БД. **Это сотрёт все данные**, сначала сделайте бэкап:

```bash
docker compose down
docker volume rm forus-chatbot_surreal-data
docker compose up -d
```

### RAG: «Duplicate document» / «No new unique documents»

Тот же документ уже есть в индексе. Загрузите другой файл или сбросьте индекс
целиком — **это сотрёт весь RAG-корпус**:

```bash
docker compose down
docker volume rm forus-chatbot_rag-storage
docker compose --profile rag up -d
```

Предупреждения про multimodal и «Missing required fields» на работу поиска
обычно не влияют: в `rag-api` для LightRAG частично стоит упрощённая
LLM-заглушка.
