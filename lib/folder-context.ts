/**
 * Блок системного промпта «Контекст проекта» — инструкции папки,
 * в которой лежит диалог.
 */

/** ≈5 000 токенов русского текста (2.34 символа/токен). */
export const FOLDER_CONTEXT_MAX_CHARS = 12000;

export type FolderContextInput = {
  name: string;
  instructions?: string | null;
};

/** Собрать блок или вернуть '' — если инструкций нет. */
export function buildFolderContextBlock(
  input: FolderContextInput,
  maxChars = FOLDER_CONTEXT_MAX_CHARS,
): string {
  const instructions = String(input.instructions ?? '').trim();
  if (!instructions) return '';

  const head =
    `\n\n## Контекст проекта «${input.name}»\n` +
    'Справка о проекте, к которому относится встреча. Используй для терминов, ' +
    'названий организаций, должностей и сокращений. Это НЕ замена регламенту и НЕ ' +
    'источник фактов о самой встрече: факты встречи берутся только из расшифровки и ответов пользователя.\n';

  const budget = Math.max(0, maxChars - head.length);

  const label = '\n### Инструкции проекта\n';
  const text = instructions.slice(0, Math.max(0, budget - label.length - 1));

  return `${head}${label}${text}\n`;
}
