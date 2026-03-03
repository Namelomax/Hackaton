# AISDK (Протоколёр) — Инструкции для AI-агентов

## О проекте

Next.js (App Router) чат-приложение с AI SDK для генерации **протоколов обследования** на основе расшифровок встреч с заказчиком.

**Стек:** React 19, Next.js 16, TypeScript, AI SDK, Vercel Blob, SurrealDB, shadcn/ui, Tailwind CSS v4

---

## Архитектура

### Агентская система (multi-agent orchestration)

```
POST /api/chat → runMainAgent()
                   ├─ classifyIntent() → 'chat' | 'document'
                   └─ decideNextAction() → route to agent
                                           ├─ runChatAgent() — диалог, сбор информации
                                           └─ runDocumentAgent() — генерация протокола
```

**Ключевые файлы:**
- `app/api/chat/route.ts` — основной endpoint, нормализация сообщений, извлечение текста из вложений
- `app/api/chat/agents/main-agent.ts` — оркестрация агентов
- `app/api/chat/agents/classifier.ts` — классификация намерений (LLM-based)
- `app/api/chat/agents/orchestrator.ts` — логика маршрутизации
- `app/api/chat/agents/chat-agent.ts` — диалоговый агент
- `app/api/chat/agents/document-agent.ts` — генерация протоколов

### Структура протокола (строго по схеме)

Протокол содержит **10 обязательных разделов** (`lib/schemas/protocol-schema.ts`):

1. Дата встречи (ДД.ММ.ГГГГ)
2. Повестка (тема + пункты)
3. Участники (таблицы: Заказчик / Исполнитель)
4. Термины и определения
5. Сокращения и обозначения
6. Содержание встречи (topics, subtopics, migrationFeatures)
7. Вопросы и ответы
8. Решения с ответственными
9. Открытые вопросы
10. Согласовано (подписи)

**Важно:** Агент не импровизирует — использует только факты из расшифровки. При отсутствии данных указывает "Информация не предоставлена".

---

## Команды разработки

```bash
npm run dev       # Next.js dev-сервер (Turbopack)
npm run build     # Production build
npm run start     # Production сервер
npm run lint      # Biome check
npm run format    # Biome format --write
npm run test      # Jest тесты
```

**Важно:** Не нужно запускать `npm run build` после каждого изменения — это замедляет разработку. Используйте `npm run dev` для горячей перезагрузки.

**Переменные окружения (минимум):**
- `OPENROUTER_API_KEY` — доступ к моделям
- `SURREALDB` — строка подключения к SurrealDB
- `GEMINI_API_KEY` — опционально, для Gemini

---

## Конвенции и паттерны

### Код и стиль

- **TypeScript:** strict mode, пути через `@/*` (root)
- **Форматирование:** Biome (2 пробела, space indent)
- **Компоненты:** shadcn/ui + Radix UI, иконки Lucide
- **Стилизация:** Tailwind CSS v4 (utility-first)

### Обработка сообщений

Сообщения хранятся в формате **UIMessage** (`parts` array):

```typescript
{
  id: string,
  role: 'user' | 'assistant',
  parts: [{ type: 'text', text: string } | { type: 'file', ... }],
  metadata: { attachments: [...], hiddenTexts: [...] }
}
```

**Переносы строк в сообщениях:**
- Для сохранения переносов строк в пользовательских сообщениях используется `remark-breaks` в компоненте `Response`
- `Shift+Enter` в поле ввода добавляет перенос строки, `Enter` отправляет сообщение

**Извлечение текста из вложений:**
- PDF → `pdf-parse`
- DOCX → `mammoth` (DOC → `word-extractor`)
- XLSX/XLS → `xlsx`
- PPTX/PPT → `jszip` + парсинг XML

### Потоковая передача данных

DocumentAgent отправляет кастомные события через SSE:

| Тип события | Описание |
|------------|----------|
| `data-title` | Заголовок документа |
| `data-clear` | Очистка контента |
| `data-documentDelta` | Добавление фрагмента Markdown |
| `data-finish` | Завершение генерации |
| `data-docx` | Base64 .docx файл для скачивания |

### Хранение данных (SurrealDB)

**Таблицы:**
- `users` — пользователи (username, passwordHash, selectedPrompt)
- `prompts` — системные промпты (isDefault, owner)
- `conversations` — диалоги (messages[], document_content)
- `protocol_examples` — примеры протоколов
- `protocol_instructions` — инструкции для генерации

**Важно:** `messages` сохраняется как array<object> + fallback `messages_raw` (JSON string).

### Обработка ошибок

**Восстановление после ошибки:**
- После любой ошибки (включая "слишком большой контекст") статус автоматически возвращается в `'ready'` через 500мс
- Пользователь может продолжить работу в том же чате или создать новый
- `submitLockRef` сбрасывается сразу после ошибки или остановки потока
- Не блокируйте возможность отправки сообщений после ошибки

### Проверка документов (Review Agent)

**Детерминированная проверка:**
- `review-agent.ts` использует температуру `0.0` и `seed: 42` для воспроизводимости
- Одинаковый документ всегда выдаёт одинаковые замечания
- Категории ошибок: `error` (критично), `warning` (желательно исправить), `info` (информация)

**Алгоритм проверки:**
1. Проверка структуры (все 10 разделов)
2. Проверка полноты (нет пустых разделов)
3. Проверка кодировки (китайские символы, control characters)
4. Проверка формата дат (ДД.ММ.ГГГГ)
5. Проверка таблиц (заголовки, данные)
6. Проверка терминологии (консистентность)
7. Проверка пунктуации

**Исправление замечаний:**
- `chat-agent.ts` распознаёт запросы на исправление (`исправь` + `замечан`/`ошибк`)
- Используется специальный промпт `buildFixIssuesPrompt()` с документом и списком замечаний
- ИИ обязан исправить все замечания и показать полную исправленную версию

---

## Ключевые компоненты UI

```
components/
├── chat/
│   ├── Header.tsx          # Auth, бренд
│   ├── Sidebar.tsx         # Список диалогов
│   ├── ConversationArea.tsx # Чат-зона
│   ├── MessageRenderer.tsx  # Рендер сообщений с remark-breaks
│   └── PromptInputWrapper.tsx # Input с attachments
├── document/
│   ├── DocumentPanel.tsx   # Правая панель (Markdown + .docx)
│   └── DocumentReviewPanel.tsx # Замечания к документу
└── ai-elements/
    ├── response.tsx        # Рендер Markdown (remark-breaks)
    └── message.tsx         # Базовый компонент сообщения
```

---

## Внешние зависимости

| Сервис | Назначение |
|--------|------------|
| **OpenRouter** | LLM-провайдер (arcee-ai/trinity-large-preview:free) |
| **SurrealDB** | БД (wss://wild-mountain-06cupioiq9vpbadmqsbcb609a8.aws-euw1.surreal.cloud) |
| **Vercel Blob** | Хранение вложений (`@vercel/blob`) |

---

## Тестирование

**Jest config:** `jest.config.js`
- Test environment: `jsdom`
- moduleNameMapper: `@/*` → `<rootDir>/$1`
- Setup: `jest.setup.ts`

**Пример теста** (`lib/__tests__/utils.test.ts`):

```typescript
import { cn, isTextExtractable } from '@/lib/utils';

describe('cn helper', () => {
  it('merges conditional class names', () => {
    const result = cn('base', false && 'hidden', ['flex', 'items-center']);
    expect(result).toBe('base flex items-center');
  });
});
```

---

## Примечания

- **DocumentPanel** автоматически генерирует `.docx` из Markdown через `@mohtasham/md-to-docx`
- **Скачивание ZIP:** документ + все вложения через `jszip`
- **Аутентификация:** простая (username/passwordHash в SurrealDB)
- **Сессии:** `activeConversationId` в localStorage
- **Не запускать сборку** для проверки изменений — используйте `npm run dev`
