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
