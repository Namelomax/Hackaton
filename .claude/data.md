# Данные: схемы, БД, форматы

## Protocol Schema (Zod)

**Файл:** `lib/schemas/protocol-schema.ts`

```typescript
Protocol {
  // Шапка
  protocolNumber: string        // "№7"
  meetingDate: string           // "ДД.ММ.ГГГГ"
  protocolTitle: string         // Краткое название встречи
  contractNumber?: string       // Номер договора
  contractDate?: string         // "ДД.ММ.ГГГГ"
  contractSubject?: string      // Тема/предмет договора

  // Раздел 2
  agenda: {
    items: string[]             // ["Согласование...", "Утверждение..."]
  }

  // Раздел 3
  participants: {
    customer: {
      organizationName: string
      people: [{ fullName: string, position: string }]
    }
    executor: {
      organizationName: string
      people: [{ fullName: string, position: string }]
    }
  }

  // Раздел 4
  meetingContent: {
    topics: [{
      title: string        // Название вопроса (совпадает с повесткой)
      listened: string     // Только ФИО через запятую
      discussed: string    // Официальное описание обсуждения
      decided: string      // Решение с датой и ответственным
    }]
    summary: [{
      question: string     // Вопрос из повестки
      decision: string     // "Решение. Срок: ДД.ММ.ГГГГ. Ответственный: ФИО, сторона."
    }]
  }

  // Раздел 5
  approval: {
    customer: { organization: string, signatories: string[] }
    executor: { organization: string, signatories: string[] }
  }
}
```

**Добавление нового поля в Protocol:**
1. `lib/schemas/protocol-schema.ts` → Zod schema + `coerceProtocolPartial()`
2. `app/api/chat/agents/document-agent.ts` → `protocolToMarkdown()`
3. `lib/docx-generator.ts` → `generateProtocolDocx()`
4. `lib/prompts/sgr-prompts.ts` → `SGR_DOCUMENT_AGENT_PROMPT` (инструкция LLM)

## SurrealDB — таблицы

**Файл схемы:** `lib/db/schema.ts`

### Таблица `prompt`
```sql
DEFINE TABLE prompt SCHEMAFULL;
  id         (auto)
  title      STRING REQUIRED
  content    STRING REQUIRED      -- полный текст системного промпта
  isDefault  BOOL DEFAULT false
  time.created  DATETIME READONLY
  time.updated  DATETIME
  owner      OPTION<record<users>>
```

### Таблица `users`
```sql
DEFINE TABLE users SCHEMAFULL;
  id           (auto)
  username     STRING REQUIRED -- уникальный, lowercase, индексирован
  passwordHash STRING REQUIRED -- bcrypt
  created      DATETIME
```

### Таблица `conversations`
```sql
DEFINE TABLE conversations SCHEMAFULL;
  id               UUID (auto)
  user_id          record<users>
  messages         ARRAY   -- нормализованные UIMessage[]
  document_content STRING  -- последняя версия протокола (markdown)
  created          DATETIME
  updated          DATETIME
```

### Таблица `user_selected_prompt`
```sql
-- Хранит выбранный пользователем промпт
user_id   → prompt_id
```

## Нормализация сообщений

Входящие сообщения бывают в разных форматах. `conversationMessages.ts` нормализует всё к:

```typescript
UIMessage {
  id: string
  role: "user" | "assistant"
  parts: [{ type: "text", text: string }, ...]
  metadata: {
    attachments?: [{
      name: string
      content: string | null   // null если только Gemini fileId
      fileId?: string          // Gemini File API ID
    }]
  }
}
```

**Вложения в сообщениях:**
- Текст файла → `metadata.attachments[].content`
- Для длинных расшифровок (>4000 chars) → попадает в `hiddenDocsContext` (system-block)
- Старые вложения → `[Документ «name» был приложен ранее и доступен в системном блоке]`

## Форматы данных для document-agent

**AGREED_CHAT_CONTEXT** — блок подтверждённых пользователем данных.

Формируется через `buildProtocolDraftFromChat()` + `formatChatDraftForPrompt()`:
- Ищет паттерн: assistant предложил → user написал "верно"/"да"/"ок"/...
- Извлекает участников, вопросы повестки, содержание
- Форматирует как `СОГЛАСОВАНО С ПОЛЬЗОВАТЕЛЕМ В ЧАТЕ: ...`

LLM в document-agent должен приоритизировать этот блок над raw-расшифровкой.

## Переменные окружения

### Обязательные
```bash
SURREALDB_URL=ws://localhost:8000/rpc
SURREALDB_NAMESPACE=chatbot
SURREALDB_DATABASE=main
SURREALDB_USER=root
SURREALDB_PASSWORD=root
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama
```

### Ollama (тонкая настройка)
```bash
OLLAMA_CONTEXT_LENGTH=131072          # Контекстное окно
OLLAMA_MAX_OUTPUT_TOKENS=32768        # Макс. токенов ответа (общий)
OLLAMA_FILE_TURN_MAX_OUTPUT_TOKENS=2048  # После загрузки файла
OLLAMA_PROTOCOL_MAX_OUTPUT_TOKENS=32768  # Генерация документа
OLLAMA_STREAM_HEARTBEAT_MS=15000      # Лог каждые N мс
ALLOWED_OLLAMA_MODELS=qwen3.5:9b      # Разрешённые модели (comma-sep)
```

### Параллельные запросы Ollama

`OLLAMA_NUM_PARALLEL` — переменная Ollama-сервера (не Next.js!). Задаётся в окружении процесса `ollama serve`.

```bash
# В systemd / docker-compose / env Ollama-сервера:
OLLAMA_NUM_PARALLEL=1   # (дефолт) — очередь из одного запроса
OLLAMA_NUM_PARALLEL=2   # два параллельных запроса
```

**Расчёт памяти для параллельных слотов:**

Каждый дополнительный слот требует VRAM для KV-кеша (веса модели не дублируются):
```
KV-кеш на слот ≈ context_length × num_layers × 2 × dtype_bytes
Qwen3.5:9b (128K ctx, 36 слоёв, fp16):
  ≈ 131072 × 36 × 2 × 2 байта ≈ ~18 ГБ — слишком много при 128K контексте!

При уменьшенном контексте (32K):
  ≈ 32768 × 36 × 2 × 2 ≈ ~4.5 ГБ на слот
```

**Практические рекомендации:**

| Ситуация | Рекомендация |
|---------|-------------|
| Память на пределе | `OLLAMA_NUM_PARALLEL=1` — запросы ставятся в очередь, не падают |
| Есть запас 4–6 ГБ VRAM | `OLLAMA_NUM_PARALLEL=2` + уменьшить `OLLAMA_CONTEXT_LENGTH=32768` |
| Нужен настоящий параллелизм | Горизонтальное масштабирование: 2 инстанса Ollama + load balancer |

**Поведение при `NUM_PARALLEL=1` и нескольких пользователях:**
- Второй запрос ставится в очередь (не отклоняется и не зависает)
- Пользователь просто ждёт дольше
- Это нормальное поведение при небольшой нагрузке (до ~5 одновременных пользователей)

**Диагностика текущего параллелизма:**
```bash
# Сколько параллельных слотов активно прямо сейчас:
curl http://localhost:11434/api/ps
```

### OpenRouter (вместо Ollama)
```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL_DEFAULT=nvidia/nemotron-3-super-120b-a12b:free
ALLOWED_OPENROUTER_MODELS=model/a,model/b   # опционально
```

### RAG-сервис
```bash
RAG_API_URL=http://rag-api:8000
RAG_LOCAL_OPENAI_BASE_URL=http://ollama:11434/v1
LOCAL_OPENAI_EMBEDDING_MODEL=nomic-embed-text
RAG_EMBEDDING_DIM=768
RAG_EMBEDDING_MAX_TOKENS=512
RAG_OLLAMA_BASE_URL=http://ollama:11434/v1
RAG_OLLAMA_LLM_MODEL=qwen3:14b
RAG_OLLAMA_LLM_TIMEOUT=600
```

### Gemini (опционально, для fallback загрузки файлов)
```bash
GOOGLE_GENERATIVE_AI_API_KEY=AIza...
```

### Vercel Blob (опционально, для хранения файлов в облаке)
```bash
BLOB_READ_WRITE_TOKEN=...
```

### Next.js публичные
```bash
NEXT_PUBLIC_SURREAL_URL=ws://127.0.0.1:8000/rpc  # URL для браузера
WEB_PORT=127.0.0.1:3000
```

### Псевдонимы (cloud-шаблоны SurrealDB)
```bash
SURREAL_URL        → SURREALDB_URL
SURREAL_NAMESPACE  → SURREALDB_NAMESPACE
SURREAL_PASS       → SURREALDB_PASSWORD
```

## Типы файлов — обработка при загрузке

| Расширение | Библиотека | Fallback |
|-----------|-----------|---------|
| .docx | mammoth | — |
| .doc | word-extractor | bestEffortBinaryText() |
| .xlsx, .xls | xlsx | bestEffortBinaryText() |
| .pptx, .ppt | JSZip (ручной парсинг) | bestEffortBinaryText() |
| .pdf | pdf-parse | Gemini File API |
| .txt, .md | Buffer.toString('utf8') | — |
| .json | Buffer.toString('utf8') | — |
| прочее | — | Gemini File API |

`bestEffortBinaryText()` — ищет readable runs (40+ символов латиницы/кириллицы) в бинарном содержимом.
