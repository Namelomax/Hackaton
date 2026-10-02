/**
 * Наследие удалённого режима «Облако + анонимизация» (убран 02.10.2026).
 *
 * Пока режим работал, в редких случаях протокол сохранялся с плейсхолдерами
 * (`[PERSON_3]`) вместо настоящих имён. Соответствия «плейсхолдер → оригинал»
 * остались в таблице anonymization_mappings, и при чтении диалога мы
 * подставляем их обратно — детерминированно, без модели. Новых плейсхолдеров
 * больше не появляется; модуль можно удалить вместе с этими записями.
 */
export const LEGACY_PLACEHOLDER_RX = /\[(?:PERSON|ORG|DATE|SENSITIVE|FILE|EMAIL|PHONE)_\d+\]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Заменить плейсхолдеры на оригиналы. Длинные ключи первыми: `[PERSON_10]` раньше `[PERSON_1]`. */
export function restorePlaceholders(text: string, mapping: Record<string, string>): string {
  if (!text || !mapping || Object.keys(mapping).length === 0) return text;
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  return text.replace(pattern, (token) =>
    Object.hasOwn(mapping, token) ? mapping[token] : token,
  );
}
