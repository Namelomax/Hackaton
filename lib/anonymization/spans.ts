/**
 * Спан и разрешение перекрытий — порт `anonymizer/spans.py` + таблицы
 * приоритетов из `anonymizer/detectors.py`.
 */

/**
 * Найденный фрагмент чувствительного текста.
 *
 * `mergeKey` и `canonicalText` — механизм группировки РАЗНЫХ поверхностных форм
 * одной сущности под одним плейсхолдером. Обычно два спана делят плейсхолдер,
 * только если совпали метка и текст (без учёта регистра). Канонизация
 * (`canonicalize.ts`) выставляет `mergeKey`, когда решает, что «Форус» и
 * «Форуса» — одно и то же; `canonicalText` при этом хранит форму, которая
 * попадёт в mapping и будет подставлена при деанонимизации.
 */
export interface Span {
  start: number;
  end: number;
  label: string;
  text: string;
  /** Кто нашёл: 'gliner' | 'regex' | … — для диагностики. */
  source?: string;
  mergeKey?: string;
  canonicalText?: string;
  /** Уверенность детектора, если он её сообщает (GLiNER — сообщает). */
  score?: number;
}

/**
 * Вес метки при разрешении перекрытий: чем больше, тем сильнее.
 * Метки, которых здесь нет, получают 0.
 *
 * Значения скопированы из `DEFAULT_PRIORITY` (detectors.py) — важно держать
 * таблицы одинаковыми, иначе TS и Python по-разному разрешат один и тот же
 * конфликт и результаты анонимизации разойдутся.
 */
export const DEFAULT_PRIORITY: Record<string, number> = {
  CUSTOM_TERM: 95,
  EMAIL: 90,
  URL: 90,
  IP_ADDRESS: 90,
  ACCOUNT: 88,
  BIK: 85,
  OKPO: 85,
  OKVED: 85,
  OKTMO: 85,
  OKATO: 85,
  MEDICAL: 84,
  VIN: 84,
  PLATE: 84,
  CADASTRE: 84,
  BANK_ACCOUNT: 82,
  PASSPORT: 80,
  SNILS: 80,
  INN: 80,
  OMS: 80,
  DRIVER_LICENSE: 80,
  MILITARY_ID: 80,
  BIRTH_CERTIFICATE: 80,
  KPP: 80,
  OGRN: 80,
  STAFF_ID: 78,
  CREDIT_CARD: 70,
  CONTRACT: 65,
  ORG: 62,
  FIRST_NAME: 60,
  LAST_NAME: 60,
  MIDDLE_NAME: 60,
  ADMIN_CODE: 60,
  FILE: 58,
  SUBJECT: 56,
  SENSITIVE: 55,
  AMOUNT: 55,
  POSTAL_CODE: 52,
  COUNTRY: 50,
  REGION: 50,
  DISTRICT: 50,
  CITY: 50,
  STREET: 50,
  HOUSE: 50,
  DATE: 45,
  PHONE: 40,
};

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Убрать перекрывающиеся спаны, оставив в каждой позиции самый сильный.
 *
 * Победитель выбирается по, в порядке убывания важности: вес метки, длина
 * спана, более раннее начало. `score` — последний тайбрейк: в Python-версии
 * его нет (там спаны приходят из детекторов без уверенности), но GLiNER её
 * отдаёт, и при полном равенстве остального ей разумно верить.
 *
 * Результат отсортирован по `start` и не содержит перекрытий — именно это
 * требуется шагу подстановки плейсхолдеров.
 */
export function resolveOverlaps(
  spans: Span[],
  priority: Record<string, number> = DEFAULT_PRIORITY,
): Span[] {
  const rank = (s: Span): [number, number, number, number] => [
    priority[s.label] ?? 0,
    s.end - s.start,
    -s.start,
    s.score ?? 0,
  ];

  // Сильнейшие первыми: жадный проход оставляет лучший и отбрасывает конфликты.
  const ordered = [...spans].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return rb[i] - ra[i];
    }
    return 0;
  });

  const kept: Span[] = [];
  for (const span of ordered) {
    if (kept.some((k) => overlaps(span, k))) continue;
    kept.push(span);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

// Пары, чью парность выравниваем. Прямые кавычки (") не входят: открывающая и
// закрывающая неотличимы.
const BALANCED_PAIRS: readonly (readonly [string, string])[] = [
  ['«', '»'],
  ['(', ')'],
];

function countOccurrences(text: string, needle: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) if (text[i] === needle) n++;
  return n;
}

/**
 * Границы спана после выравнивания непарных «ёлочек» и скобок.
 *
 * Детекторы не знают о парности и режут кавычки посимвольно: DATE-регэксп
 * захватывал `«12» сентября`, NER возвращал `«Технопарка «Сколково` без
 * закрывающей. Правило: если внутри спана есть непарная кавычка, а её пара
 * стоит ВПЛОТНУЮ снаружи — забираем пару в спан; если пары рядом нет, а
 * непарная кавычка стоит на краю спана — выталкиваем её наружу. Непарную
 * кавычку в СЕРЕДИНЕ спана не трогаем — так в исходном тексте.
 */
export function rebalanceBounds(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;

  for (const [opener, closer] of BALANCED_PAIRS) {
    for (;;) {
      const opens = countOccurrences(text, opener, s, e);
      const closes = countOccurrences(text, closer, s, e);

      // Пара стоит снаружи вплотную к границе — забираем её в спан.
      if (closes > opens && s > 0 && text[s - 1] === opener) {
        s -= 1;
        continue;
      }
      if (opens > closes && e < text.length && text[e] === closer) {
        e += 1;
        continue;
      }
      // Пары рядом нет — выталкиваем непарный КРАЕВОЙ символ из спана.
      if (closes > opens && e > s && text[e - 1] === closer) {
        e -= 1;
        continue;
      }
      if (opens > closes && s < e && text[s] === opener) {
        s += 1;
        continue;
      }
      break;
    }
  }

  return [s, e];
}

/** `rebalanceBounds` поверх спана: возвращает новый спан с выровненными границами. */
export function rebalanceQuotes(text: string, span: Span): Span {
  const [start, end] = rebalanceBounds(text, span.start, span.end);
  if ((start === span.start && end === span.end) || end <= start) return span;
  return { ...span, start, end, text: text.slice(start, end) };
}
