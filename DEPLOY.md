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

---

## Локальная разработка без Docker

- Запустите SurrealDB, rag-api (`uvicorn`) и Next (`npm run dev`) отдельно.
- Укажите `SURREALDB_URL`, `RAG_API_URL`, `OLLAMA_BASE_URL` на адреса ваших сервисов на localhost.
