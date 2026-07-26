# Протоколер — AGENTS.md

> AI-ассистент для составления протоколов встреч. Пользователь загружает расшифровку совещания, ведёт диалог с агентом, получает готовый протокол в формате DOCX согласно корпоративному регламенту.

## Быстрый старт

```bash
npm run dev        # Dev-сервер на :3000
npm run build      # Сборка
npm run lint       # Biome (линтер + форматтер)
npm test           # Jest
npm run inspect:surreal  # Отладка БД
```

## Стек

| Слой | Технология |
|------|-----------|
| Framework | Next.js 15 App Router, React 19 |
| AI | Vercel AI SDK v5 + Ollama (Qwen3) / OpenRouter |
| Database | SurrealDB (NoSQL, WebSocket) |
| Styling | Tailwind CSS 4 + shadcn/ui |
| RAG | FastAPI-сервис (внешний, `RAG_API_URL`) |
| DOCX | `docx` library (локально) |
| Linting | Biome 2 |

## Структура проекта

```
app/api/chat/
  route.ts               ← главный обработчик чата (контекст, RAG, роутинг)
  agents/
    main-agent.ts        ← маршрутизатор: chat vs document
    chat-agent.ts        ← интерактивный диалог + инструменты
    document-agent.ts    ← генерация финального протокола (JSON → DOCX)
    orchestrator.ts      ← определение intent пользователя
    classifier.ts        ← LLM-классификатор (chat|document)
    protocol-tools.ts    ← publishInvestigationProtocol tool
    rag-tools.ts         ← retrieveFromIndexedDocuments tool

lib/
  prompts/
    sgr-prompts.ts       ← системные промпты агентов ({{REGULATION}} плейсхолдер)
    regulation.ts        ← ЕДИНСТВЕННЫЙ ФАЙЛ правил регламента — менять здесь
  schemas/
    protocol-schema.ts   ← Zod-схема Protocol + coercion + validation
  db/
    schema.ts            ← DDL SurrealDB: таблицы prompt, users, conversations
    connection.ts        ← синглтон-соединение с переподключением
  protocol-chat-extract.ts  ← извлечение подтверждённых блоков из чата
  protocol-markdown-format.ts ← форматирование для markdown и DOCX
  docx-generator.ts     ← генерация .docx файла
  resolve-chat-model.ts ← выбор провайдера Ollama/OpenRouter
```

## Детальная документация

- **[.Codex/architecture.md](.Codex/architecture.md)** — полный data flow, архитектура агентов
- **[.Codex/ai-system.md](.Codex/ai-system.md)** — промпты, SGR, регламент, как менять поведение AI
- **[.Codex/data.md](.Codex/data.md)** — схемы БД, Protocol schema, форматы сообщений

## Критические правила для разработки

### Изменение поведения AI
- **Правила протокола (регламент)** → только `lib/prompts/regulation.ts`
- **Поведение чат-агента** → `lib/prompts/sgr-prompts.ts` → `SGR_MAIN_AGENT_PROMPT`
- **Генерация документа** → `lib/prompts/sgr-prompts.ts` → `SGR_DOCUMENT_AGENT_PROMPT`
- Регламент инжектируется через `{{REGULATION}}` в document-agent и как system message в chat-agent

### Protocol schema
- Добавление поля → обновить `lib/schemas/protocol-schema.ts` (Zod) + `coerceProtocolPartial()` + `protocolToMarkdown()` в document-agent + `generateProtocolDocx()` в docx-generator
- LLM часто возвращает кривой JSON → `coerceProtocolPartial()` нормализует перед валидацией

### База данных (SurrealDB)
- Схема инициализируется при старте через `lib/db/schema.ts`
- DDL содержит `DEFINE TABLE IF NOT EXISTS` — безопасно перезапускать
- Подключение — WebSocket-синглтон, переподключается при обрыве

### Контекстное окно
- Русский текст ≈ 2.34 символа/токен (используется для оценки)
- История чата автообрезается если превышает бюджет
- Лимит Qwen3: 131 072 токена; зарезервировано ~9 000 токенов на системный промпт + ответ

### Стриминг
- Два параллельных потока: текст чата + обновления документа (правая панель)
- Document updates: `data-title`, `data-documentDelta`, `data-clear`, `data-docx`, `data-finish`

## Переменные окружения (минимум)

```bash
SURREALDB_URL=ws://localhost:8000/rpc
SURREALDB_NAMESPACE=chatbot
SURREALDB_DATABASE=main
SURREALDB_USER=root
SURREALDB_PASSWORD=root
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama
```

Полный список → [.Codex/data.md](.Codex/data.md#переменные-окружения)
