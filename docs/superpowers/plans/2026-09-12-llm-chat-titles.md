# Автогенерация названий чатов через LLM — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После отправки первого сообщения чат автоматически получает осмысленное название по теме обсуждения (или по названию совещания из приложенной расшифровки) вместо дефолтного «Чат».

**Architecture:** Новый эндпоинт `POST /api/conversations/title` генерирует название локальной моделью Ollama и сам сохраняет его в SurrealDB. Клиент дёргает его фоновым запросом сразу после `sendMessage`, не блокируя основной ответ. Вся текстовая логика (сборка исходника, санитайзер ответа модели, фолбэк без модели) вынесена в чистый модуль `lib/chat-title.ts` и покрыта юнит-тестами.

**Tech Stack:** Next.js 15 App Router, Vercel AI SDK v5 (`generateText`), Ollama (Qwen3), SurrealDB, Jest + ts-jest, Biome.

**Спека:** `docs/superpowers/specs/2026-09-12-llm-chat-titles-design.md`

## Global Constraints

- **Только локальная Ollama для генерации названия.** Ни при каких настройках чата запрос на заголовок не уходит в OpenRouter: исходник — сырая расшифровка с ПДн, анонимизатор к этому моменту её не обработал (152-ФЗ). Всегда `resolveChatLanguageModel({ chatProvider: 'ollama', useThinking: false })`.
- **Регулярки по русскому тексту — только явные классы `[а-яёА-ЯЁ]`.** `\w`, `\W`, `\b` в JS работают по ASCII: `\b` перед кириллицей не срабатывает, `\w+` рвёт русские слова. Это уже давало тихие баги в проекте.
- **`maxOutputTokens` в любом вызове `generateText` обязателен.** Без явного значения fetch-обёртка `lib/resolve-chat-model.ts` подставляет `ollamaHardCapOutputTokens()`, и шлюз отвечает 400 ещё до генерации (разобрано в `app/api/chat/agents/classifier.ts:107-117`).
- **Определение «дефолтного» заголовка одно на проект** — `isGenericChatTitle` из `lib/chat-display.ts`. Не дублировать условие ни на клиенте, ни на сервере.
- **Язык комментариев и сообщений коммитов — русский**, как во всём проекте.
- **Линтер:** `npm run lint` (Biome 2) должен проходить после каждой задачи.
- Существующий `normalizeConversationTitle` (`app/page.tsx:327`) не трогать.

---

### Task 1: Чистые функции работы с заголовком (`lib/chat-title.ts`)

**Files:**
- Create: `lib/chat-title.ts`
- Test: `lib/__tests__/chat-title.test.ts`

**Interfaces:**
- Consumes: `isGenericChatTitle` из `lib/chat-display.ts` (уже существует).
- Produces:
  ```ts
  export function buildTitleSource(
    text: string | null | undefined,
    attachmentTexts: Array<string | null | undefined>,
    limit?: number,   // по умолчанию 4000
  ): string;

  export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null;

  export function fallbackTitleFromSource(source: string): string | null;

  export const TITLE_MAX_LENGTH = 60;
  ```

- [ ] **Step 1: Написать падающий тест**

Создать `lib/__tests__/chat-title.test.ts`:

```ts
import {
  buildTitleSource,
  fallbackTitleFromSource,
  sanitizeGeneratedTitle,
  TITLE_MAX_LENGTH,
} from '../chat-title';

describe('sanitizeGeneratedTitle', () => {
  it('вырезает <think>…</think> и берёт то, что после', () => {
    const raw = '<think>Пользователь прислал расшифровку. Тема — охлаждение.</think>\nПриёмка узла охлаждения';
    expect(sanitizeGeneratedTitle(raw)).toBe('Приёмка узла охлаждения');
  });

  it('вырезает незакрытый <think> — модель обрывается по лимиту токенов', () => {
    expect(sanitizeGeneratedTitle('<think>размышляю и не успел закрыть тег')).toBeNull();
  });

  it('снимает кавычки-ёлочки и служебный префикс', () => {
    expect(sanitizeGeneratedTitle('Название: «Перенос сроков поставки»')).toBe('Перенос сроков поставки');
    expect(sanitizeGeneratedTitle('Тема: "Бюджет на 2027 год"')).toBe('Бюджет на 2027 год');
    expect(sanitizeGeneratedTitle('Заголовок: Ремонт кровли')).toBe('Ремонт кровли');
  });

  it('из многострочного ответа берёт только первую значимую строку', () => {
    expect(sanitizeGeneratedTitle('\n\nСогласование сметы\nЭто название отражает тему.')).toBe(
      'Согласование сметы',
    );
  });

  it('снимает точку в конце, но сохраняет вопросительный знак', () => {
    expect(sanitizeGeneratedTitle('Обсуждение графика.')).toBe('Обсуждение графика');
    expect(sanitizeGeneratedTitle('Кто отвечает за приёмку?')).toBe('Кто отвечает за приёмку?');
  });

  it('схлопывает лишние пробелы', () => {
    expect(sanitizeGeneratedTitle('Приёмка    узла   охлаждения')).toBe('Приёмка узла охлаждения');
  });

  it('обрезает длинный ответ по границе слова, итог не длиннее лимита', () => {
    const long =
      'Совещание по вопросам организации приёмки оборудования системы охлаждения главного корпуса';
    const result = sanitizeGeneratedTitle(long)!;
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
    // Резать нужно по границе слова. Проверяем именно это: отбросив
    // многоточие, получаем префикс оригинала, за которым в оригинале идёт
    // пробел. (Проверять «последний символ не буква» бессмысленно — при
    // корректной резке там как раз буква, последняя буква целого слова.)
    const withoutEllipsis = result.slice(0, -1);
    expect(long.startsWith(withoutEllipsis)).toBe(true);
    expect(long[withoutEllipsis.length]).toBe(' ');
  });

  it('возвращает null на пустом и на дефолтном заголовке', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull();
    expect(sanitizeGeneratedTitle(null)).toBeNull();
    expect(sanitizeGeneratedTitle('   ')).toBeNull();
    expect(sanitizeGeneratedTitle('Чат')).toBeNull();
    expect(sanitizeGeneratedTitle('чат')).toBeNull();
    expect(sanitizeGeneratedTitle('Новый чат 3')).toBeNull();
    expect(sanitizeGeneratedTitle('New conversation')).toBeNull();
  });

  it('возвращает null на слишком коротком ответе', () => {
    expect(sanitizeGeneratedTitle('ок')).toBeNull();
  });

  it('РЕГРЕССИЯ: кириллица не теряется — \\w и \\b в JS работают по ASCII', () => {
    // Санитайзер, написанный на \w/\b, на этой строке вернул бы пустоту.
    expect(sanitizeGeneratedTitle('Ёлочные закупки')).toBe('Ёлочные закупки');
  });
});

describe('buildTitleSource', () => {
  it('ставит текст сообщения перед текстом вложений', () => {
    const source = buildTitleSource('составь протокол', ['СТЕНОГРАММА\nо приёмке']);
    expect(source.indexOf('составь протокол')).toBeLessThan(source.indexOf('СТЕНОГРАММА'));
  });

  it('пропускает пустые и null-вложения', () => {
    expect(buildTitleSource('текст', [null, '', '   ', 'файл'])).toBe('текст\n\nфайл');
  });

  it('режет хвост, а не начало — шапка расшифровки всегда сверху', () => {
    const head = 'ТЕМА СОВЕЩАНИЯ: приёмка';
    const source = buildTitleSource(head, ['x'.repeat(10_000)], 100);
    expect(source.length).toBe(100);
    expect(source.startsWith(head)).toBe(true);
  });

  it('на пустом входе возвращает пустую строку', () => {
    expect(buildTitleSource(null, [])).toBe('');
    expect(buildTitleSource(undefined, [null])).toBe('');
  });
});

describe('fallbackTitleFromSource', () => {
  it('берёт первую значимую строку', () => {
    expect(fallbackTitleFromSource('\n\nСовещание по бюджету\nИванов: добрый день')).toBe(
      'Совещание по бюджету',
    );
  });

  it('возвращает null на пустом исходнике', () => {
    expect(fallbackTitleFromSource('')).toBeNull();
    expect(fallbackTitleFromSource('   \n  \n')).toBeNull();
  });

  it('длинную первую строку обрезает как обычный заголовок', () => {
    const source =
      'Совещание по вопросам организации приёмки оборудования системы охлаждения главного корпуса';
    const result = fallbackTitleFromSource(source)!;
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `npx jest lib/__tests__/chat-title.test.ts`
Expected: FAIL — `Cannot find module '../chat-title'`.

- [ ] **Step 3: Написать реализацию**

Создать `lib/chat-title.ts`:

```ts
/**
 * Текстовая обвязка автогенерации названий чатов: что скормить модели, как
 * разобрать её ответ и что показать, если модели нет.
 *
 * Модуль намеренно чистый (никакой сети и БД) — вся хрупкая логика разбора
 * живёт здесь и покрыта тестами, а роут остаётся тонким.
 *
 * ВАЖНО про регулярки. Весь текст здесь русский, поэтому классы `\w`, `\W` и
 * граница слова `\b` в JS НЕ ПОДХОДЯТ: они определены по ASCII, `\b` перед
 * кириллицей не срабатывает, `\w+` рвёт слова. Всюду ниже — явные классы
 * `[а-яёА-ЯЁ]` и `[^\s]`.
 */
import { isGenericChatTitle } from './chat-display';

/** Максимальная длина заголовка в сайдбаре (вместе с многоточием обрезки). */
export const TITLE_MAX_LENGTH = 60;

/** Короче этого ответ модели считаем мусором («ок», «да»). */
const TITLE_MIN_LENGTH = 3;

/** Сколько символов исходника отдаём модели. ≈1700 токенов при 2.34 симв/токен. */
const DEFAULT_SOURCE_LIMIT = 4000;

/** Обрамляющие кавычки всех видов, которые модель любит добавлять. */
const WRAPPING_QUOTES = /^["'«»“”„`]+|["'«»“”„`]+$/g;

/** Служебный префикс ответа: «Название:», «Заголовок:», «Тема:». */
const SERVICE_PREFIX = /^\s*(?:название|заголовок|тема|title)\s*[:—-]\s*/i;

/**
 * Исходник для модели: текст сообщения, затем текст вложений.
 *
 * Обрезаем ХВОСТ, а не начало: в расшифровках шапка с темой, датой и повесткой
 * всегда сверху, и именно она нужна для названия.
 */
export function buildTitleSource(
  text: string | null | undefined,
  attachmentTexts: Array<string | null | undefined>,
  limit: number = DEFAULT_SOURCE_LIMIT,
): string {
  const parts = [text, ...(Array.isArray(attachmentTexts) ? attachmentTexts : [])]
    .map((part) => String(part ?? '').trim())
    .filter((part) => part.length > 0);

  return parts.join('\n\n').slice(0, limit);
}

/** Обрезать до лимита по границе слова, добавив многоточие. */
function truncateTitle(value: string): string {
  if (value.length <= TITLE_MAX_LENGTH) return value;
  // Место под многоточие резервируем заранее, чтобы итог влез в лимит целиком.
  const room = TITLE_MAX_LENGTH - 1;
  const head = value.slice(0, room);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > room / 2 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}…`;
}

/**
 * Ответ модели → готовый заголовок, либо null, если ответ непригоден.
 *
 * Qwen3 отдаёт `<think>…</think>` даже при `useThinking: false`, а при упоре в
 * лимит токенов тег остаётся незакрытым — режем оба случая.
 */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  let value = String(raw ?? '');
  if (!value.trim()) return null;

  value = value.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Незакрытый <think>: всё после него — обрывок рассуждения, не заголовок.
  value = value.replace(/<think>[\s\S]*$/i, '');

  const firstLine = value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  let title = firstLine
    .replace(SERVICE_PREFIX, '')
    .replace(WRAPPING_QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Точку в конце снимаем, вопросительный и восклицательный знаки — часть смысла.
  title = title.replace(/\.+$/, '').trim();

  if (title.length < TITLE_MIN_LENGTH) return null;
  if (isGenericChatTitle(title)) return null;

  return truncateTitle(title);
}

/**
 * Запасной заголовок без модели: первая значимая строка исходника.
 *
 * Нужен, когда Ollama недоступна или ответила мусором. «Стенограмма совещания
 * от 12.09» в сайдбаре полезнее, чем очередной безликий «Чат».
 */
export function fallbackTitleFromSource(source: string): string | null {
  return sanitizeGeneratedTitle(source);
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что проходят**

Run: `npx jest lib/__tests__/chat-title.test.ts`
Expected: PASS, все блоки `describe` зелёные.

- [ ] **Step 5: Прогнать линтер**

Run: `npm run lint`
Expected: без ошибок в `lib/chat-title.ts` и `lib/__tests__/chat-title.test.ts`.

- [ ] **Step 6: Коммит**

```bash
git add lib/chat-title.ts lib/__tests__/chat-title.test.ts
git commit -m "feat: чистые функции для автогенерации названия чата"
```

---

### Task 2: Промпт и чтение текущего заголовка из БД

**Files:**
- Modify: `lib/prompts/sgr-prompts.ts` (добавить экспорт в конец файла)
- Modify: `lib/getPromt.ts` (добавить функцию после `renameConversation`, она заканчивается на строке 828)

**Interfaces:**
- Consumes: `connectDB`, `RecordId` — уже импортированы в `lib/getPromt.ts`.
- Produces:
  ```ts
  // lib/prompts/sgr-prompts.ts
  export const SGR_CHAT_TITLE_PROMPT: string;   // содержит плейсхолдер {{SOURCE}}

  // lib/getPromt.ts
  export async function getConversationTitle(convId: string): Promise<string | null>;
  ```

- [ ] **Step 1: Добавить промпт**

В конец `lib/prompts/sgr-prompts.ts`:

```ts

/**
 * Название чата по первому сообщению пользователя.
 *
 * Ответ идёт прямо в сайдбар, поэтому от модели нужна голая строка без
 * рассуждений, кавычек и префиксов. Санитайзер (lib/chat-title.ts) всё равно
 * подчистит, но чем чище ответ, тем реже срабатывает фолбэк.
 */
export const SGR_CHAT_TITLE_PROMPT = `Ты придумываешь короткое название для чата в системе составления протоколов совещаний.

Ниже — начало того, что прислал пользователь: его сообщение и/или начало расшифровки совещания.

ТРЕБОВАНИЯ К НАЗВАНИЮ:
- 2–6 слов на русском языке
- отражает ТЕМУ совещания или вопроса, а не действие пользователя
- без ФИО, должностей и названий организаций
- без кавычек, без точки в конце, без префиксов вроде «Название:»
- если в тексте явно указана тема совещания — используй её

ПЛОХО: «Запрос пользователя», «Протокол», «Совещание», «Обработка расшифровки»
ХОРОШО: «Приёмка узла охлаждения», «Перенос сроков поставки», «Бюджет на 2027 год»

В ОТВЕТЕ — ТОЛЬКО САМО НАЗВАНИЕ, одной строкой. Никаких пояснений.

ТЕКСТ:
{{SOURCE}}`;
```

- [ ] **Step 2: Написать тест на промпт**

В `lib/__tests__/chat-title.test.ts` дописать импорт к уже существующим
импортам **в начале файла**:

```ts
import { SGR_CHAT_TITLE_PROMPT } from '../prompts/sgr-prompts';
```

и добавить блок в конец файла:

```ts
describe('SGR_CHAT_TITLE_PROMPT', () => {
  it('содержит плейсхолдер {{SOURCE}} — иначе исходник не подставится', () => {
    expect(SGR_CHAT_TITLE_PROMPT).toContain('{{SOURCE}}');
  });
});
```

- [ ] **Step 3: Запустить тест**

Run: `npx jest lib/__tests__/chat-title.test.ts`
Expected: PASS (промпт уже добавлен на шаге 1).

- [ ] **Step 4: Добавить `getConversationTitle` в `lib/getPromt.ts`**

Вставить сразу после закрывающей скобки `renameConversation` (перед `export async function deleteConversation`):

```ts
/**
 * Текущий заголовок диалога, либо null если записи нет.
 *
 * Ошибку чтения ПРОБРАСЫВАЕМ, а не превращаем в null: вызывающий роут по null
 * решает «заголовок дефолтный, можно перезаписать», и проглоченный сбой БД
 * означал бы затирание названия, которое пользователь задал руками.
 */
export async function getConversationTitle(convId: string): Promise<string | null> {
  await connectDB();
  const clean = convId.replace(/^conversations:/, '');
  const recordObj = new RecordId('conversations', clean);
  const raw = await db.select(recordObj);
  const convData = Array.isArray(raw) ? raw[0] : raw;
  if (!convData) return null;
  const title = (convData as any).title;
  return typeof title === 'string' ? title : null;
}
```

- [ ] **Step 5: Проверить сборку типов и линтер**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без новых ошибок в `lib/getPromt.ts` и `lib/prompts/sgr-prompts.ts`.

Run: `npm run lint`
Expected: без ошибок.

- [ ] **Step 6: Коммит**

```bash
git add lib/prompts/sgr-prompts.ts lib/getPromt.ts lib/__tests__/chat-title.test.ts
git commit -m "feat: промпт названия чата и чтение текущего заголовка из БД"
```

---

### Task 3: Эндпоинт `POST /api/conversations/title`

**Files:**
- Create: `app/api/conversations/title/route.ts`
- Читать как образец гардов: `app/api/conversations/route.ts:90-144`

**Interfaces:**
- Consumes (всё уже существует после Task 1 и 2):
  ```ts
  import { buildTitleSource, fallbackTitleFromSource, sanitizeGeneratedTitle } from '@/lib/chat-title';
  import { isGenericChatTitle } from '@/lib/chat-display';
  import { getConversationTitle, renameConversation, assertConversationOwnership, ForbiddenError } from '@/lib/getPromt';
  import { resolveRequestUserId } from '@/lib/auth-session';
  import { extractAttachmentTextCached } from '@/lib/attachment-extract';
  import { resolveChatLanguageModel } from '@/lib/resolve-chat-model';
  import { SGR_CHAT_TITLE_PROMPT } from '@/lib/prompts/sgr-prompts';
  import { generateText } from 'ai';
  ```
- Produces: HTTP-контракт, который использует Task 4:
  - Запрос: `{ conversationId: string, text?: string, files?: Array<{ id?, filename?, url?, mediaType? }>, userId?: string }`
  - Ответ 200: `{ success: true, title: string, generated: boolean }`
  - Ответ 400/403/503/500: `{ success: false, message: string }`

- [ ] **Step 1: Создать роут**

Создать `app/api/conversations/title/route.ts`:

```ts
/**
 * POST /api/conversations/title — придумать и сохранить название диалога.
 *
 * Зовётся с клиента фоном сразу после отправки первого сообщения, параллельно
 * основному ответу агента. Отдельный роут, а не ветка /api/chat: там уже
 * роутинг агентов, RAG, анонимизация и два SSE-потока, и в облачном режиме он
 * работает через OpenRouter — а название генерируем ВСЕГДА локально.
 *
 * ПОЧЕМУ ВСЕГДА OLLAMA. Исходник — сырое сообщение пользователя и начало
 * расшифровки, то есть ПДн, которые ещё не проходили анонимизатор. Отправить
 * их во внешнего провайдера нельзя (152-ФЗ), даже ради двух слов заголовка.
 */
import { generateText } from 'ai';
import { extractAttachmentTextCached } from '@/lib/attachment-extract';
import { resolveRequestUserId } from '@/lib/auth-session';
import { isGenericChatTitle } from '@/lib/chat-display';
import { buildTitleSource, fallbackTitleFromSource, sanitizeGeneratedTitle } from '@/lib/chat-title';
import {
  assertConversationOwnership,
  ForbiddenError,
  getConversationTitle,
  renameConversation,
} from '@/lib/getPromt';
import { SGR_CHAT_TITLE_PROMPT } from '@/lib/prompts/sgr-prompts';
import { resolveChatLanguageModel } from '@/lib/resolve-chat-model';

export const runtime = 'nodejs';

function ok(title: string, generated: boolean) {
  return Response.json({ success: true, title, generated }, { status: 200 });
}

function fail(message: string, status: number) {
  return Response.json({ success: false, message }, { status });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
    if (!conversationId || conversationId.startsWith('local-')) {
      return fail('conversationId required', 400);
    }

    const userId = resolveRequestUserId(req, body.userId as string | undefined);

    // Изоляция диалогов: тот же гард, что в /api/conversations и /api/chat.
    try {
      await assertConversationOwnership(conversationId, userId);
    } catch (e) {
      if (e instanceof ForbiddenError) return fail('Forbidden', 403);
      console.error('[title] ownership check failed:', e);
      return fail('Проверка доступа временно недоступна', 503);
    }

    // Идемпотентность именно ЗДЕСЬ, а не только на клиенте: две вкладки могут
    // прийти одновременно, а ручное переименование не должно затираться.
    let currentTitle: string | null;
    try {
      currentTitle = await getConversationTitle(conversationId);
    } catch (e) {
      console.error('[title] не удалось прочитать текущий заголовок:', e);
      return fail('Хранилище временно недоступно', 503);
    }
    if (currentTitle && !isGenericChatTitle(currentTitle)) {
      return ok(currentTitle, false);
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const files = Array.isArray(body.files) ? body.files : [];
    // Кэш разбора общий с /api/chat — docx/pdf второй раз не парсится.
    const attachmentTexts = await Promise.all(
      files.map((att) => extractAttachmentTextCached(att).catch(() => null)),
    );
    const source = buildTitleSource(text, attachmentTexts);
    if (!source) return ok(currentTitle || 'Чат', false);

    let title: string | null = null;
    try {
      const model = resolveChatLanguageModel({ chatProvider: 'ollama', useThinking: false });
      const { text: rawOutput } = await generateText({
        model,
        temperature: 0.2,
        /**
         * Лимит обязателен. Без него fetch-обёртка resolve-chat-model.ts
         * подставляет ollamaHardCapOutputTokens(), запрос уходит с
         * max_tokens во весь контекст модели, и шлюз отвечает 400 ДО
         * генерации. Ровно на это уже наступал классификатор интента.
         */
        maxOutputTokens: 120,
        prompt: SGR_CHAT_TITLE_PROMPT.replace('{{SOURCE}}', source),
      });
      title = sanitizeGeneratedTitle(rawOutput);
    } catch (e) {
      // Модель недоступна — это не повод отдавать 500: заголовок штука
      // необязательная, но и оставлять «Чат» незачем, когда есть исходник.
      console.warn('[title] генерация названия не удалась:', (e as Error)?.message);
    }

    const generated = title !== null;
    if (!title) title = fallbackTitleFromSource(source);
    if (!title) return ok(currentTitle || 'Чат', false);

    await renameConversation(conversationId, title);
    return ok(title, generated);
  } catch (err) {
    console.error('Conversations title POST error', err);
    return fail((err as Error)?.message || 'error', 500);
  }
}
```

- [ ] **Step 2: Проверить типы**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок в `app/api/conversations/title/route.ts`.

- [ ] **Step 3: Проверить линтер**

Run: `npm run lint`
Expected: без ошибок.

- [ ] **Step 4: Проверить роут вручную**

Поднять dev-сервер: `npm run dev`

Без сессии роут обязан отказать, а не что-то сгенерировать:

```bash
curl -s -X POST http://localhost:3000/api/conversations/title \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"conversations:doesnotexist","text":"совещание по переносу сроков поставки"}'
```

Expected: HTTP 200 с `{"success":true,...}` для несуществующего диалога без владельца (гард такие пропускает — красть нечего) **или** 403, если id принадлежит чужому диалогу. Главное — не 500 и не падение процесса.

Проверка валидации:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/conversations/title \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: `400`.

- [ ] **Step 5: Коммит**

```bash
git add app/api/conversations/title/route.ts
git commit -m "feat: эндпоинт генерации названия чата"
```

---

### Task 4: Подключение на клиенте

**Files:**
- Modify: `components/chat/PromptInputWrapper.tsx` — новый проп `onAutoTitle` (тип рядом с `anonymizeMode` в `PromptInputWrapperProps`, ~строка 215), деструктуризация в параметрах (~строка 248), вызов в `handleSubmit` сразу после `sendMessage(...)` (блок заканчивается на строке 600)
- Modify: `app/page.tsx` — импорт, ref, колбэк, проп у `<PromptInputWrapper>` (строка 1349)

**Interfaces:**
- Consumes: HTTP-контракт из Task 3, `isGenericChatTitle` из `lib/chat-display.ts`.
- Produces:
  ```ts
  // PromptInputWrapperProps
  onAutoTitle?: (args: {
    conversationId: string;
    text: string;
    files: FileUIPart[];
  }) => void;
  ```

- [ ] **Step 1: Добавить проп в `PromptInputWrapper`**

В `PromptInputWrapperProps` (рядом с `anonymizeMode?: boolean;`) добавить:

```ts
  /** Фоновая автогенерация названия чата после первого сообщения.
   *  Вызывается ВСЕГДА; решение «надо ли» принимает сама страница. */
  onAutoTitle?: (args: { conversationId: string; text: string; files: FileUIPart[] }) => void;
```

В списке параметров компонента (рядом с `anonymizeMode = false,`) добавить:

```ts
  onAutoTitle,
```

- [ ] **Step 2: Вызвать колбэк после отправки**

В `handleSubmit`, сразу после закрывающей скобки вызова `sendMessage(...)` и перед `setInput('');`, добавить:

```ts
      // Название чата генерируется фоном, параллельно ответу агента: ждать
      // его здесь нельзя — форма должна очиститься немедленно.
      if (ensuredConversationId) {
        onAutoTitle?.({
          conversationId: ensuredConversationId,
          text: textWithQuote,
          files: finalFiles,
        });
      }

```

- [ ] **Step 3: Добавить импорт и ref в `app/page.tsx`**

К импортам (после строки с `chat-models`) добавить:

```ts
import { isGenericChatTitle } from '@/lib/chat-display';
```

Рядом с `const conversationsListRef = useRef<any[]>([]);` (строка 185) добавить:

```ts
  /** Диалоги, для которых запрос названия уже в полёте — чтобы не слать дважды. */
  const autoTitleInFlightRef = useRef<Set<string>>(new Set());
```

- [ ] **Step 4: Реализовать колбэк**

Перед `const handleRenameConversation = async (conv: any) => {` (строка 1029) вставить:

```ts
  /**
   * Фоновая автогенерация названия чата после первого сообщения.
   *
   * Проверки здесь — оптимизация, а не гарантия: последнее слово всё равно за
   * сервером, который сам перечитывает заголовок перед записью. Ошибки гасим
   * в консоль: это фоновое удобство, и ругаться на него тостом неуместно.
   */
  const handleAutoTitle = useCallback(
    ({ conversationId: convId, text, files }: { conversationId: string; text: string; files: any[] }) => {
      if (!convId || String(convId).startsWith('local-')) return;
      if (autoTitleInFlightRef.current.has(convId)) return;

      const conv = (conversationsListRef.current || []).find((c) => c?.id === convId);
      // Диалога ещё нет в списке — он только что создан, заголовок дефолтный.
      if (conv && !isGenericChatTitle(conv.title)) return;

      autoTitleInFlightRef.current.add(convId);
      void (async () => {
        try {
          const resp = await fetch('/api/conversations/title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId: convId,
              text,
              files: (files || []).map((f: any) => ({
                id: f?.id,
                filename: f?.filename,
                url: f?.url,
                mediaType: f?.mediaType,
              })),
              userId: authUser?.id,
            }),
          });
          const json = await resp.json();
          if (json?.success && typeof json.title === 'string' && json.title.trim()) {
            setConversationsList((prev) =>
              prev.map((c) => (c.id === convId ? { ...c, title: json.title } : c)),
            );
          }
        } catch (e) {
          console.warn('[autoTitle] не удалось сгенерировать название чата', e);
        } finally {
          autoTitleInFlightRef.current.delete(convId);
        }
      })();
    },
    [authUser?.id],
  );

```

- [ ] **Step 5: Передать проп**

В `<PromptInputWrapper ... />` (строка 1349), рядом с `anonymizeMode={anonymizeMode}`, добавить:

```tsx
                onAutoTitle={handleAutoTitle}
```

- [ ] **Step 6: Проверить типы и линтер**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: без ошибок.

Run: `npm run lint`
Expected: без ошибок.

- [ ] **Step 7: Убедиться, что старые тесты не сломались**

Run: `npm test`
Expected: PASS, счётчик тестов не меньше, чем до правок.

- [ ] **Step 8: Коммит**

```bash
git add components/chat/PromptInputWrapper.tsx app/page.tsx
git commit -m "feat: фоновый запрос названия чата после первого сообщения"
```

---

### Task 5: Сквозная ручная проверка

**Files:** ничего не меняется, если все сценарии проходят.

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: подтверждение готовности фичи.

- [ ] **Step 1: Поднять окружение**

Run: `npm run dev`
Убедиться, что SurrealDB и Ollama подняты (переменные из `CLAUDE.md`).

- [ ] **Step 2: Название по тексту сообщения**

Войти под пользователем → «Новый» → отправить: `Составь протокол по совещанию о переносе сроков поставки`.
Expected: через 1–3 с в сайдбаре вместо «Чат» появляется осмысленное название (например, «Перенос сроков поставки»).

- [ ] **Step 3: Название по расшифровке**

Новый чат → приложить `.docx` с расшифровкой, текст сообщения оставить пустым → отправить.
Expected: название отражает тему совещания из шапки расшифровки.

- [ ] **Step 4: Ручное переименование не затирается**

На чате из шага 2 нажать карандаш, задать `Моё название` → отправить ещё одно сообщение.
Expected: заголовок остался `Моё название`. В Network видно ответ `{"success":true,"generated":false}`.

- [ ] **Step 5: Облачный режим не утекает наружу**

Включить «Облако + анонимизация» → новый чат → отправить сообщение.
Expected: название сгенерировалось. В логах сервера запрос заголовка идёт в Ollama; в OpenRouter запроса на заголовок нет.

- [ ] **Step 6: Фолбэк при недоступной модели**

Остановить Ollama → новый чат → отправить сообщение с текстом `Совещание по бюджету\nИванов: добрый день`.
Expected: чат называется «Совещание по бюджету», в логах `[title] генерация названия не удалась`, интерфейс работает.
Поднять Ollama обратно.

- [ ] **Step 7: Название переживает перезагрузку**

F5 на чате из шага 2.
Expected: название на месте — значит, записано в SurrealDB, а не только в состоянии React.

- [ ] **Step 8: Финальная проверка и коммит (если были правки)**

Run: `npm test && npm run lint && npm run build`
Expected: всё зелёное.

---

## Порядок задач

Task 1 → Task 2 → Task 3 → Task 4 → Task 5. Task 3 зависит от экспортов Task 1 и 2; Task 4 — от HTTP-контракта Task 3.
