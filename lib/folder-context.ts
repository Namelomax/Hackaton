/**
 * Блок системного промпта «Контекст проекта» — инструкции и фрагменты
 * источников папки, в которой лежит диалог.
 */

/** ≈5 000 токенов русского текста (2.34 символа/токен). */
export const FOLDER_CONTEXT_MAX_CHARS = 12000;

/** Фрагмент RAG короче этого — шум, в промпт не идёт (как и в авто-RAG диалога). */
export const FOLDER_SNIPPET_MIN_CHARS = 80;

export type FolderContextInput = {
  name: string;
  instructions?: string | null;
  sourcesExcerpt?: string | null;
};

/**
 * Собрать блок или вернуть '' — если ни инструкций, ни источников нет.
 * Инструкции важнее: их пишет человек целенаправленно, поэтому при обрезке
 * страдают фрагменты источников.
 */
export function buildFolderContextBlock(
  input: FolderContextInput,
  maxChars = FOLDER_CONTEXT_MAX_CHARS,
): string {
  const instructions = String(input.instructions ?? '').trim();
  const excerptRaw = String(input.sourcesExcerpt ?? '').trim();
  const excerpt = excerptRaw.length >= FOLDER_SNIPPET_MIN_CHARS ? excerptRaw : '';
  if (!instructions && !excerpt) return '';

  const head =
    `\n\n## Контекст проекта «${input.name}»\n` +
    'Справка о проекте, к которому относится встреча. Используй для терминов, ' +
    'названий организаций, должностей и сокращений. Это НЕ замена регламенту и НЕ ' +
    'источник фактов о самой встрече: факты встречи берутся только из расшифровки и ответов пользователя.\n';

  let budget = Math.max(0, maxChars - head.length);
  let body = '';

  if (instructions) {
    const label = '\n### Инструкции проекта\n';
    const text = instructions.slice(0, Math.max(0, budget - label.length - 1));
    body += `${label}${text}\n`;
    budget -=label.length + text.length + 1;
  }

  if (excerpt) {
    const label = '\n### Фрагменты источников проекта\n';
    const room = budget - label.length - 1;
    if (room >= FOLDER_SNIPPET_MIN_CHARS) {
      const text = excerpt.length > room ? `${excerpt.slice(0, room - 1)}…` : excerpt;
      body += `${label}${text}\n`;
    }
  }

  return head + body;
}

/** Запрос к индексу папки — по последней реплике пользователя. */
export function folderRagQuery(lastUserText: string, max = 1000): string {
  return String(lastUserText ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
