/**
 * Каноническая перенумерация плейсхолдеров на стороне Next.js.
 *
 * Удалённый сервер /anonymize при каждом вызове нумерует плейсхолдеры заново
 * с `_1` по каждой метке и НЕ принимает входной mapping. Чтобы `[PERSON_1]` во
 * всём диалоге означал одного и того же человека (и в документе, и в
 * сообщениях), мы держим ЕДИНЫЙ канонический mapping диалога и при каждой
 * анонимизации:
 *   1. берём свежий результат сервера (его плейсхолдеры → оригиналы),
 *   2. известные оригиналы переиспользуют существующий канонический плейсхолдер
 *      (это и есть кеш/«хеширование» — повторные ПДн не плодят новые номера),
 *   3. новым оригиналам выдаём следующий номер по метке,
 *   4. перестраиваем анонимный текст под канонические плейсхолдеры.
 *
 * Для уже известных значений сервер вообще можно не дёргать — достаточно
 * детерминированной локальной подстановки (`applyMappingForward`).
 */
import type {
  ConversationMapping,
  LabelCounters,
  Mapping,
  PlaceholderAlias,
  RemoteAnonymizeResult,
  AnonymizeMergeResult,
} from './types';

const WORD_CH = '0-9A-Za-zА-Яа-яЁё';
const PLACEHOLDER_TOKEN_RE = /\[[A-Z_]+_\d+\]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[PERSON_1]` → `PERSON`; `[MILITARY_ID_1]` → `MILITARY_ID`. */
export function labelOf(placeholder: string): string {
  const inner = placeholder.replace(/^\[/, '').replace(/\]$/, '');
  const idx = inner.lastIndexOf('_');
  return idx === -1 ? inner : inner.slice(0, idx);
}

/** Ключ группировки «тот же это объект или нет» — как `_normalize` в Python. */
function normalizeKey(label: string, text: string): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
  return `${label} ${collapsed.toLowerCase()}`;
}

/** Восстанавливает счётчики номеров по существующему mapping. */
export function countersFromMapping(mapping: Mapping): LabelCounters {
  const counters: LabelCounters = {};
  for (const ph of Object.keys(mapping)) {
    const label = labelOf(ph);
    const m = ph.match(/_(\d+)\]$/);
    const n = m ? Number(m[1]) : 0;
    if (n > (counters[label] ?? 0)) counters[label] = n;
  }
  return counters;
}

/** Обратный индекс normalizeKey → канонический плейсхолдер по текущему mapping. */
function buildReverseIndex(mapping: Mapping): Map<string, string> {
  const rev = new Map<string, string>();
  for (const [ph, original] of Object.entries(mapping)) {
    rev.set(normalizeKey(labelOf(ph), original), ph);
  }
  return rev;
}

/** Экранированный шаблон оригинала с границами слова (чтобы не резать середину). */
function boundedOriginal(orig: string): string {
  const esc = escapeRegExp(orig);
  const first = orig[0];
  const last = orig[orig.length - 1];
  const pre = first && new RegExp(`[${WORD_CH}]`).test(first) ? `(?<![${WORD_CH}])` : '';
  const post = last && new RegExp(`[${WORD_CH}]`).test(last) ? `(?![${WORD_CH}])` : '';
  return pre + esc + post;
}

/** Заменяет список оригиналов на их плейсхолдеры (длинные первыми). */
function substituteOriginals(
  text: string,
  pairs: { original: string; ph: string }[],
): string {
  const items = pairs
    .filter((it) => it.original && it.original.length > 0)
    .sort((a, b) => b.original.length - a.original.length);
  if (items.length === 0) return text;

  const inverse = new Map<string, string>();
  for (const { original, ph } of items) {
    if (!inverse.has(original)) inverse.set(original, ph);
  }
  const uniqueOriginals = [...inverse.keys()];
  const pattern = new RegExp(uniqueOriginals.map(boundedOriginal).join('|'), 'g');
  return text.replace(pattern, (m) => inverse.get(m) ?? m);
}

/**
 * Локальная детерминированная подстановка оригинал → канонический плейсхолдер
 * по уже известному mapping. Без вызова сервера. Используется, чтобы заново
 * зачистить документ/историю диалога при каждом ходе (быстро и согласованно).
 */
export function applyMappingForward(text: string, mapping: Mapping): string {
  if (!text || !mapping || Object.keys(mapping).length === 0) return text;
  const pairs = Object.entries(mapping).map(([ph, original]) => ({ ph, original }));
  return substituteOriginals(text, pairs);
}

// Токен-компонент ФИО (имя/фамилия/отчество): слово из букв, с заглавной, >= 3 симв.
// Одиночные инициалы («И.») и короткие частицы отсекаются длиной.
const NAME_TOKEN_RE = /^[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]{2,}$/;

/** Компоненты ФИО для отдельной подстановки (только метка PERSON). */
function personNameFragments(label: string, original: string): string[] {
  if (label !== 'PERSON') return [];
  return original.split(/\s+/).filter((t) => NAME_TOKEN_RE.test(t));
}

/**
 * Как applyMappingForward, но ДОПОЛНИТЕЛЬНО подставляет отдельные компоненты
 * ФИО (имя/фамилия/отчество). Нужно, потому что серверный NER мог пометить
 * полное «Никита Грицанюк» как [PERSON_4], а одиночное «Никита» в другом месте
 * пропустить. mapping хранит только полный оригинал, поэтому обычная
 * подстановка одиночное имя не ловит — и оно утекает в облако. Здесь для каждого
 * PERSON добавляем его слова-компоненты, указывающие на тот же плейсхолдер.
 * Полное ФИО длиннее компонентов и заменяется первым (границы слов сохраняются).
 */
export function applyMappingForwardDeep(
  text: string,
  mapping: Mapping,
  aliases: PlaceholderAlias[] = [],
): string {
  const hasMapping = mapping && Object.keys(mapping).length > 0;
  if (!text || (!hasMapping && aliases.length === 0)) return text;
  const pairs: { original: string; ph: string }[] = [];
  for (const [ph, original] of Object.entries(mapping ?? {})) {
    if (!original) continue;
    pairs.push({ original, ph });
    for (const frag of personNameFragments(labelOf(ph), original)) {
      pairs.push({ original: frag, ph });
    }
  }
  // Склонённые формы («Ирины Соколовой» → [PERSON_1]) идут наравне с
  // каноническими значениями: substituteOriginals сортирует по длине, поэтому
  // длинная форма срабатывает раньше короткой, а границы слов соблюдаются
  // (простое split/join резало бы «Ирин» внутри «Ирины»).
  for (const a of aliases) {
    if (a?.value && a?.placeholder) pairs.push({ original: a.value, ph: a.placeholder });
  }
  return substituteOriginals(text, pairs);
}

/** Заменяет токены-плейсхолдеры по словарю translation (длинные первыми). */
function retokenize(text: string, translation: Map<string, string>): string {
  if (translation.size === 0) return text;
  const keys = [...translation.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(escapeRegExp).join('|'), 'g');
  return text.replace(pattern, (m) => translation.get(m) ?? m);
}

/**
 * Мерж свежего результата сервера в канонический mapping диалога.
 * Возвращает анонимный текст с КАНОНИЧЕСКИМИ плейсхолдерами и обновлённый mapping.
 */
export function mergeRemoteResult(
  conv: ConversationMapping,
  remote: RemoteAnonymizeResult,
): AnonymizeMergeResult {
  const mapping: Mapping = { ...conv.mapping };
  const counters: LabelCounters = { ...conv.counters };
  const reverse = buildReverseIndex(mapping);

  // Склонённые формы, уже подтверждённые раньше («Ирины Соколовой» →
  // [PERSON_1]), переиспользуют свой плейсхолдер. Без этого сервер каждый раз
  // отдавал бы «новое» значение, мы заводили бы новый номер, и склейку падежей
  // приходилось бы гонять через модель на каждом ходе.
  for (const a of conv.aliases ?? []) {
    if (!a?.value || !a?.placeholder) continue;
    if (!Object.prototype.hasOwnProperty.call(mapping, a.placeholder)) continue;
    const key = normalizeKey(labelOf(a.placeholder), a.value);
    if (!reverse.has(key)) reverse.set(key, a.placeholder);
  }

  const translation = new Map<string, string>(); // serverPlaceholder → canonicalPlaceholder
  let added = 0;

  for (const [serverPh, original] of Object.entries(remote.mapping ?? {})) {
    const label = labelOf(serverPh);
    const key = normalizeKey(label, original);
    let canonical = reverse.get(key);
    if (!canonical) {
      const next = (counters[label] ?? 0) + 1;
      counters[label] = next;
      canonical = `[${label}_${next}]`;
      mapping[canonical] = original;
      reverse.set(key, canonical);
      added += 1;
    }
    translation.set(serverPh, canonical);
  }

  const anonymizedText = retokenize(remote.anonymized_text ?? '', translation);
  return {
    anonymizedText,
    conversation: { mapping, counters, aliases: conv.aliases ?? [] },
    added,
  };
}

/** Есть ли в тексте хоть один плейсхолдер. */
export function hasPlaceholders(text: string): boolean {
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  return PLACEHOLDER_TOKEN_RE.test(text);
}
