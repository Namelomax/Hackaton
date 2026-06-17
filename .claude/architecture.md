# Архитектура системы

## Общий data flow

```
Пользователь
    │
    ├─ Загружает файл ──→ /api/upload
    │                         │
    │                   Извлекает текст (mammoth/xlsx/word-extractor)
    │                   ↓ если не смог — Gemini File API
    │                   Текст → metadata.attachments в message
    │                         │
    │                   /api/rag/upload (индексирует в RAG)
    │
    ├─ Пишет в чат ──→ /api/chat/route.ts
    │                      │
    │               Строит контекст:
    │               • hiddenDocsContext (тексты вложений в system-block)
    │               • RAG snippets (если useRagContext=true)
    │               • Нормализует историю (trimming по токенам)
    │               • resolveSystemPrompt (из БД или дефолтный)
    │                      │
    │               runMainAgent(AgentContext)
    │                      │
    │               ┌──────┴──────┐
    │               │             │
    │          chat-agent    document-agent
    │          (диалог)      (генерация DOCX)
    │
    └─ Скачивает DOCX ──→ /api/download-docx
```

## Маршрутизация агентов

```
route.ts
  └─ runMainAgent(context)
       │
       ├─ explicitDocumentGenerationRequest(lastUserText)?
       │    ↓ да: "сформируй/сделай/подготовь протокол"
       │   runDocumentAgent()
       │
       └─ нет: любой другой запрос
          runChatAgent(systemPrompt, userPrompt)
```

**Классификатор** (`classifier.ts`): LLM-вызов для edge-cases (когда explicit regex не сработал). Вернёт `{type:"chat"|"document", confidence: 0-1}`.

**Orchestrator** (`orchestrator.ts`): утилиты — `explicitDocumentGenerationRequest()`, `getLastUserPlainText()`.

## Chat Agent — интерактивный диалог

**Файл:** `app/api/chat/agents/chat-agent.ts`

**Задача:** собирать данные для протокола по разделам (шапка → повестка → участники → содержание → согласование), задавая уточняющие вопросы.

**Инструменты:**
| Tool | Когда вызывается |
|------|-----------------|
| `publishInvestigationProtocol` | Явная просьба "сформируй протокол" / "выведи в документ" |
| `retrieveFromIndexedDocuments` | Только если `ragRetrievalEnabled=true` и нужны данные из индекса |

**Адаптация системного промпта:**
- `adaptSystemPrompt()` — если есть вложения или >1 сообщения → добавляет "АДАПТАЦИЯ: Расшифровка получена" блок, пропускает приветствие
- `buildFixIssuesSystemAppendix()` — если пользователь просит исправить замечания → добавляет текущий документ + замечания
- Регламент (`PROTOCOL_REGULATION`) добавляется как отдельное `system` сообщение

**Поток ответа:** Server-Sent Events через `createUIMessageStreamResponse`

## Document Agent — генерация протокола

**Файл:** `app/api/chat/agents/document-agent.ts`

**Задача:** одним LLM-вызовом сгенерировать полный Protocol JSON, конвертировать в markdown → DOCX, стримить обновления в правую панель.

**Процесс:**
```
1. Извлечь всю историю чата → conversationContext (строка)
2. buildProtocolDraftFromChat() → extract confirmed sections (пользователь сказал "верно")
3. Построить protocolPrompt:
   SGR_DOCUMENT_AGENT_PROMPT
     .replace('{{REGULATION}}', PROTOCOL_REGULATION)
     .replace('{{CONVERSATION_CONTEXT}}', ...)
     .replace('{{EXISTING_DOCUMENT_CONTEXT}}', ...)
     .replace('{{AGREED_CHAT_CONTEXT}}', ...)
4. streamObject({ schema: ProtocolSchema, temperature: 0.1 })
5. Для каждого partial: coerceProtocolPartial() → mergeProtocolWithChatDraft() → protocolToMarkdown()
   → стримим data-clear + data-documentDelta в правую панель
6. Финальный объект: parseProtocolStrict() → Zod validation
7. generateProtocolDocx() → base64 → data-docx event
8. Сохраняем conversation в SurrealDB
```

**Data events (правая панель):**
```
data-title          → заголовок документа
data-clear          → очистить текущий контент
data-documentDelta  → новый markdown контент
data-finish         → генерация завершена
data-docx           → { content: base64, filename: "..." }
```

## RAG интеграция

**Сервис:** FastAPI на `RAG_API_URL` (обычно `http://rag-api:8000`)

**Два режима работы:**

1. **Pre-injection** (без RAG-инструмента): RAG-сниппеты извлекаются в `route.ts` и вставляются в system-блок до вызова агента.

2. **Tool-based** (с RAG-инструментом): `retrieveFromIndexedDocuments` вызывается chat-агентом по необходимости во время диалога. Включается если `ragRetrievalEnabled=true` И нет инлайн-транскрипта.

**Индексирование:** файлы загружаются через `/api/rag/upload` → FastAPI извлекает сущности → строит граф знаний.

## Контекстное окно и trimming

```
Полный бюджет = OLLAMA_CONTEXT_LENGTH (131 072 токена)
- Системный промпт: ~3 000
- Буфер ответа: 6 000
- Документ (правая панель): до 55% бюджета
- Оставшееся: история чата

Если история > бюджета:
  → trimMessageHistory() обрезает старые сообщения (не системные)
  → добавляет "[Предыдущие сообщения обрезаны для экономии контекста]"
```

**Оценка токенов:** `Math.round(chars / 2.34)` для русского текста.

## Тайм-коды

Формат в чате: `[ТС: ЧЧ:ММ:СС]` — ссылка на строку расшифровки.

- **В чате:** каждый факт из расшифровки должен иметь тайм-код
- **В документе:** `stripTimecodeMarkers()` убирает все тайм-коды перед генерацией

## Сохранение состояния

```
После каждого ответа агента:
  conversationId?
    ├─ да → updateConversation(id, messages, documentContent)
    └─ нет → saveConversation(userId, messages, documentContent)

Conversations хранят:
  • messages[]     — вся история нормализованных сообщений
  • document_content — последняя версия протокола (markdown)
```
