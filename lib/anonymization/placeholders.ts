/**
 * Назначение обратимых плейсхолдеров — порт `anonymizer/mapping.py`.
 *
 * Правило обратимости: одинаковые значения одной метки схлопываются в один
 * плейсхолдер (один и тот же паспорт, встреченный дважды, восстановится
 * одинаково), разные значения получают разные номера. Нумерация — по метке,
 * в порядке первого появления в тексте.
 */
import type { Mapping } from './types';
import type { Span } from './spans';

const PLACEHOLDER_RE = /\[([A-Z_]+)_(\d+)\]/g;

/** Собрать токен плейсхолдера: `('PASSPORT', 1) -> '[PASSPORT_1]'`. */
export function placeholderFor(label: string, index: number): string {
  return `[${label}_${index}]`;
}

/**
 * Ключ группировки: решает, считать ли два спана ОДНОЙ сущностью.
 *
 * Пробелы схлопываются, чтобы «812 987» и «812  987» делили плейсхолдер.
 * Регистр игнорируется. Спан может переопределить ключ через `mergeKey` —
 * так канонизация заставляет группироваться разные падежные формы.
 */
function normalizeKey(span: Span): string {
  if (span.mergeKey !== undefined) return span.mergeKey;
  const collapsed = span.text.split(/\s+/).filter(Boolean).join(' ');
  return `${span.label}\u0000${collapsed.toLowerCase()}`;
}

export interface AssignedPlaceholders {
  mapping: Mapping;
  /** Плейсхолдер для каждого спана — по индексу в переданном массиве. */
  placeholderBySpan: string[];
  /** Сколько разных сущностей найдено по каждой метке. */
  summary: Record<string, number>;
}

/**
 * Назначить плейсхолдеры спанам, переиспользуя один на каждую сущность.
 *
 * @param spans Непересекающиеся спаны, отсортированные по `start`.
 */
export function assignPlaceholders(spans: Span[]): AssignedPlaceholders {
  const counters: Record<string, number> = {};
  const byKey = new Map<string, string>();
  const mapping: Mapping = {};
  const placeholderBySpan: string[] = [];

  for (const span of spans) {
    const key = normalizeKey(span);
    let placeholder = byKey.get(key);
    if (placeholder === undefined) {
      counters[span.label] = (counters[span.label] ?? 0) + 1;
      placeholder = placeholderFor(span.label, counters[span.label]);
      byKey.set(key, placeholder);
      mapping[placeholder] = span.canonicalText ?? span.text;
    }
    placeholderBySpan.push(placeholder);
  }

  return { mapping, placeholderBySpan, summary: { ...counters } };
}

/**
 * Найти все подстроки вида `[LABEL_123]`, УЖЕ присутствующие в тексте.
 *
 * Нужно для идемпотентности: если документ анонимизировали один раз и его
 * загрузили повторно, детекторы не должны трогать эти участки. Без такой
 * защиты GLiNER охотно принимает токен плейсхолдера за новую сущность (он
 * выглядит как идентификатор с заглавных) и заворачивает его ещё раз, порождая
 * `[[PERSON_1]]` и mapping, значения которого сами являются битыми
 * плейсхолдерами (`"[ORG_2]": "[ORG_1"`).
 */
export function findPlaceholderSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null = PLACEHOLDER_RE.exec(text);
  while (m !== null) {
    out.push([m.index, m.index + m[0].length]);
    m = PLACEHOLDER_RE.exec(text);
  }
  return out;
}

/** Применить плейсхолдеры к тексту. Замены идут справа налево — offset'ы не съезжают. */
export function applySpans(
  text: string,
  spans: Span[],
  placeholderBySpan: string[],
): string {
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const placeholder = placeholderBySpan[i];
    if (!placeholder) continue;
    out = out.slice(0, span.start) + placeholder + out.slice(span.end);
  }
  return out;
}
