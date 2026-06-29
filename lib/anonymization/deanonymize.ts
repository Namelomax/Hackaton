/**
 * Обратная подстановка: возвращаем оригинальные значения по mapping. Без ИИ.
 * Порт `anonymizer/deanonymize.py` на TypeScript — детерминированная строковая
 * операция, обратная анонимизации.
 */
import type { Mapping } from './types';

const PLACEHOLDER_RE = /\[[A-Z_]+_\d+\]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Восстанавливает оригинальные значения в анонимизированном тексте.
 * Все плейсхолдеры заменяются за один проход. Ключи сортируются по длине
 * (длинные первыми), чтобы `[PERSON_1]` не перекрывал `[PERSON_10]`.
 */
export function deanonymize(text: string, mapping: Mapping): string {
  if (!text || !mapping || Object.keys(mapping).length === 0) return text;

  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g');

  return text.replace(pattern, (token) =>
    Object.prototype.hasOwnProperty.call(mapping, token) ? mapping[token] : token,
  );
}

/** Глубокая деанонимизация: рекурсивно по всем строковым листам объекта. */
export function deepDeanonymize<T>(value: T, mapping: Mapping): T {
  if (value == null) return value;
  if (typeof value === 'string') return deanonymize(value, mapping) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => deepDeanonymize(v, mapping)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepDeanonymize(v, mapping);
    }
    return out as unknown as T;
  }
  return value;
}

/** Плейсхолдеры, оставшиеся в тексте, но отсутствующие в mapping. */
export function findUnknownPlaceholders(text: string, mapping: Mapping): string[] {
  const found = text.match(PLACEHOLDER_RE) ?? [];
  return found.filter((t) => !Object.prototype.hasOwnProperty.call(mapping, t));
}
