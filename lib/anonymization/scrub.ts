/**
 * Защитный регекс-фильтр структурных ПДн (belt-and-suspenders).
 *
 * Серверная анонимизация (regex + GLiNER + LLM) ловит почти всё, но имеет
 * ненулевой процент пропусков. Перед отправкой в облако мы дополнительно
 * прогоняем уже анонимизированный текст этим детерминированным фильтром, чтобы
 * гарантированно не выпустить email, телефоны и длинные цифровые идентификаторы
 * (ИНН/СНИЛС/счёт/карта). Найденному значению присваивается канонический
 * плейсхолдер и оно добавляется в mapping — то есть остаётся обратимым.
 */
import type { ConversationMapping } from './types';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// +7/8 и 10 цифр с любыми разделителями; либо международный с префиксом +.
const PHONE_RE = /(?:\+7|8|\+\d{1,3})[\s\-(]*\d{3}[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b/g;
// Длинные цифровые идентификаторы (ИНН 10/12, СНИЛС 11, счёт/карта 12+).
const ID_RE = /\b\d{10,20}\b/g;

function normalizeKey(label: string, text: string): string {
  return `${label} ${text.split(/\s+/).filter(Boolean).join(' ').toLowerCase()}`;
}

function labelOf(ph: string): string {
  const inner = ph.replace(/^\[/, '').replace(/\]$/, '');
  const i = inner.lastIndexOf('_');
  return i === -1 ? inner : inner.slice(0, i);
}

/**
 * Маскирует оставшиеся структурные ПДн. Возвращает обновлённый текст, mapping и
 * число добавленных сущностей.
 */
export function scrubStructured(
  text: string,
  conv: ConversationMapping,
): { text: string; conversation: ConversationMapping; added: number } {
  if (!text) return { text, conversation: conv, added: 0 };

  const mapping = { ...conv.mapping };
  const counters = { ...conv.counters };
  const reverse = new Map<string, string>();
  for (const [ph, original] of Object.entries(mapping)) {
    reverse.set(normalizeKey(labelOf(ph), original), ph);
  }
  let added = 0;

  const assign = (label: string, value: string): string => {
    const key = normalizeKey(label, value);
    let ph = reverse.get(key);
    if (!ph) {
      counters[label] = (counters[label] ?? 0) + 1;
      ph = `[${label}_${counters[label]}]`;
      mapping[ph] = value;
      reverse.set(key, ph);
      added += 1;
    }
    return ph;
  };

  let out = text
    .replace(EMAIL_RE, (m) => assign('EMAIL', m))
    .replace(PHONE_RE, (m) => assign('PHONE', m))
    .replace(ID_RE, (m) => assign('ID', m));

  return { text: out, conversation: { mapping, counters }, added };
}

/** Быстрая проверка: остались ли в тексте очевидные структурные ПДн. */
export function hasStructuredPII(text: string): boolean {
  if (!text) return false;
  return (
    new RegExp(EMAIL_RE.source).test(text) ||
    new RegExp(PHONE_RE.source).test(text) ||
    new RegExp(ID_RE.source).test(text)
  );
}
