/**
 * Схлопывание падежных вариантов одной сущности в ОДИН плейсхолдер —
 * порт `anonymizer/canonicalize.py`.
 *
 * Детекторы выдают отдельный спан на каждую поверхностную форму, а назначение
 * плейсхолдеров различает `(метка, точный текст)`. Для имён это правильно, но
 * для организаций и локаций дробит одну реальную сущность:
 *
 *     Форус -> [ORG_2],  Форуса -> [ORG_7]              (одна орг., два падежа)
 *     Телеграме -> [ORG_11],  Телеграме -> [LOCATION_2] (одно, две метки)
 *
 * Утечки тут нет (замаскировано и то и другое), но mapping шумит тремя строками
 * на одну сущность, а восстановленный текст мешает формы. Модуль снимает
 * известное падежное окончание, получает общую основу и проставляет спанам
 * общий `mergeKey` ДО назначения плейсхолдеров.
 *
 * PERSON исключён НАМЕРЕННО: два разных человека могут делить основу
 * («Иванов»/«Иванова») и должны остаться разными плейсхолдерами.
 */
import type { Span } from './spans';

/** Метки, чьи падежные/меточные варианты схлопываем. PERSON — нет, см. докстринг. */
const CANON_LABELS = new Set(['ORG', 'LOCATION']);

/**
 * Падежные окончания русского языка — та же таблица, что `_DECL_SUFFIXES`
 * в detectors.py. Длинные первыми, чтобы снять максимальное окончание,
 * а не «а» из «ами».
 */
const DECL_SUFFIXES = [
  'иями', 'иях', 'ами', 'ями', 'ах', 'ях', 'ом', 'ем', 'ём', 'ой', 'ей',
  'им', 'ым', 'у', 'ю', 'е', 'и', 'ы', 'а', 'я',
].sort((a, b) => b.length - a.length);

/** Минимальная длина основы: ниже не группируем, иначе короткие основы слипаются. */
const MIN_STEM = 3;

/**
 * Краевая пунктуация и кавычки не должны влиять на ключ: `«КиберКубок 2025»`
 * и `КиберКубок 2025` — одна сущность, а раньше токен `«киберкубок` давал
 * другой ключ и сущность дробилась на два плейсхолдера.
 */
const EDGE_PUNCT = '«»"\'“”‘’.,;:!?()[]{}<>—–-№';

function stripEdgePunct(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && EDGE_PUNCT.includes(word[start])) start++;
  while (end > start && EDGE_PUNCT.includes(word[end - 1])) end--;
  return word.slice(start, end);
}

/**
 * Основа слова: снимаем известное падежное окончание, если после него остаётся
 * >= 3 символов. Так «форуса» -> «форус», «форус» -> «форус» (основа на
 * согласную не режется), «телеграме» -> «телеграм».
 */
export function wordStem(word: string): string {
  const w = stripEdgePunct(word.toLowerCase());
  for (const suf of DECL_SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= MIN_STEM) {
      return w.slice(0, w.length - suf.length);
    }
  }
  return w;
}

/** Ключ группировки: основы всех слов через пробел. */
export function groupKey(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map(wordStem)
    .filter(Boolean)
    .join(' ');
}

/**
 * Проставить общий `mergeKey` и каноничную форму падежным вариантам одной
 * ORG/LOCATION-сущности. Спаны с уже заданным `mergeKey` не трогаем — это
 * решение более сильного слоя. Возвращает НОВЫЙ массив.
 */
export function canonicalizeEntities(spans: Span[]): Span[] {
  // 1-й проход: для каждой основы выбираем каноничную форму — самую короткую
  // поверхность (обычно именительный падеж), при равной длине — по алфавиту,
  // чтобы результат не зависел от порядка спанов.
  const reps = new Map<string, string>();
  for (const s of spans) {
    if (!CANON_LABELS.has(s.label) || s.mergeKey !== undefined) continue;
    const key = groupKey(s.text);
    if (key.length < MIN_STEM) continue;
    const surface = s.text.trim();
    const cur = reps.get(key);
    if (cur === undefined || surface.length < cur.length || (surface.length === cur.length && surface < cur)) {
      reps.set(key, surface);
    }
  }

  if (reps.size === 0) return spans;

  // 2-й проход: проставляем mergeKey + каноничную форму.
  return spans.map((s) => {
    if (CANON_LABELS.has(s.label) && s.mergeKey === undefined) {
      const key = groupKey(s.text);
      const rep = reps.get(key);
      if (rep !== undefined && key.length >= MIN_STEM) {
        return { ...s, mergeKey: `CANON_ENT\u0000${key}`, canonicalText: rep };
      }
    }
    return s;
  });
}
