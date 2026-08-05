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

// --- Словарный фильтр гос/организационных наименований (аварийный фолбэк) ---
// ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ для таких терминов — глоссарий Python-анонимайзера
// (`anonymizer/custom_terms.txt`, детектор GlossaryDetector). Именно туда нужно
// добавлять новые организации/аббревиатуры: там корректная обработка склонений
// (в т.ч. «Правительство» → «правительством»), канонические имена и единый
// плейсхолдер на все алиасы.
//
// Этот TS-список — тонкий страховочный слой на стороне Next: он срабатывает по
// уже анонимизированному ответу сервера и ловит лишь то, что глоссарий вдруг
// пропустил (например, глоссарий не задеплоен). Держим здесь минимальный набор
// самых частых ведомств; кастомные термины НЕ дублируем сюда, а ведём в
// глоссарии. Разовые локальные добавки — через ANONYMIZER_EXTRA_ORG_TERMS.
// Каждая основа матчится с любыми русскими окончаниями и с границами слова.
const ORG_WORD_CH = '0-9A-Za-zА-Яа-яЁё';

const SENSITIVE_ORG_STEMS_BASE = [
  // Министерства (основа + окончания ловят «Минфина», «Минфином» и т.д.)
  'минфин', 'мингос', 'минцифр', 'минздрав', 'минобрнаук', 'минобр', 'минтруд',
  'минэконом', 'минэк', 'минпросвещ', 'минюст', 'минстрой', 'минтранс',
  'минсельхоз', 'минпромторг', 'минкультур', 'минспорт', 'минэнерго',
  'миннаук', 'министерств',
  // Органы власти и учреждения
  'правительств', 'казначейств', 'госдум', 'совфед', 'госсовет', 'администраци',
  'роскомнадзор', 'роспотребнадзор', 'рособрнадзор', 'росреестр',
  'управделами', 'управдел', 'фнс', 'пфр', 'сфр', 'фомс',
];

function sensitiveOrgStems(): string[] {
  const extra = String(process.env.ANONYMIZER_EXTRA_ORG_TERMS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Длинные основы первыми — чтобы «минобрнаук» выигрывал у «минобр».
  return [...new Set([...SENSITIVE_ORG_STEMS_BASE, ...extra])].sort((a, b) => b.length - a.length);
}

function buildOrgRegex(): RegExp {
  const stems = sensitiveOrgStems().map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Основа + любые русские буквенные окончания, с границами слова.
  const body = `(?:${stems.join('|')})[а-яё]*`;
  return new RegExp(`(?<![${ORG_WORD_CH}])(?:${body})(?![${ORG_WORD_CH}])`, 'giu');
}

/**
 * Маскирует названия ведомств/органов власти по словарю. Возвращает обновлённый
 * текст, mapping и число добавленных сущностей. Обратимо (как scrubStructured).
 */
export function scrubSensitiveOrgs(
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

  const assign = (value: string): string => {
    const key = normalizeKey('ORG', value);
    let ph = reverse.get(key);
    if (!ph) {
      counters['ORG'] = (counters['ORG'] ?? 0) + 1;
      ph = `[ORG_${counters['ORG']}]`;
      mapping[ph] = value;
      reverse.set(key, ph);
      added += 1;
    }
    return ph;
  };

  const out = text.replace(buildOrgRegex(), (m) => assign(m));
  return { text: out, conversation: { mapping, counters }, added };
}

/** Есть ли в тексте гос/орг-термин из словаря. */
export function hasSensitiveOrgs(text: string): boolean {
  if (!text) return false;
  return buildOrgRegex().test(text);
}

// --- Возврат неконфиденциальных плейсхолдеров (даты, вежливые фразы) ---
// Заказчик: анонимайзер маскирует даты и «Добрый день»/«Понятно» — это не ПДн,
// но лишает облачную модель контекста (сроки!) и портит текст. Возвращаем такие
// значения в текст ПЕРЕД отправкой в облако. Mapping не трогаем — деанонимизация
// для остальных плейсхолдеров работает как раньше.
const NON_SENSITIVE_PHRASES = new Set(
  [
    'добрый день', 'доброе утро', 'добрый вечер', 'здравствуйте', 'привет',
    'до свидания', 'всего доброго', 'спасибо', 'пожалуйста', 'понятно',
    'хорошо', 'отлично', 'коллеги', 'да', 'нет', 'ага', 'угу', 'ок', 'окей',
  ].map((s) => s.toLowerCase()),
);

// Широкий распознаватель дат/времени в ЛЮБОЙ форме — по просьбе продукта ВСЕ
// даты сохраняются при обезличивании (дата сама по себе не ПДн, а облачной
// модели она критична: сроки, относительные выражения, хронология).
const MONTHS = '(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*';
const DATE_VALUE_RE = new RegExp(
  '^\\s*(?:' +
    [
      // числовые: 25.02.2025, 25/02/25, 2025-02-25, 25.02
      '\\d{1,2}[./-]\\d{1,2}(?:[./-]\\d{2,4})?',
      '\\d{4}[./-]\\d{1,2}[./-]\\d{1,2}',
      // словесные: 25 февраля [2025] [г./года], февраль 2025, в марте
      '\\d{1,2}\\s+' + MONTHS + '(?:\\s+\\d{4})?(?:\\s*г\\.?(?:ода)?)?',
      '(?:в\\s+)?' + MONTHS + '(?:\\s+\\d{4})?(?:\\s*г\\.?(?:ода)?)?',
      // голый год: 2025, 2025 год/года/году, в 2025
      '(?:в\\s+)?(?:19|20)\\d{2}(?:\\s*год[а-яё]*)?',
      // кварталы/полугодия: II квартал 2025, 2-й квартал, первое полугодие
      '(?:[1-4]|[IV]{1,3}|перв[а-яё]+|втор[а-яё]+|трет[а-яё]+|четверт[а-яё]+)[\\s-]*(?:-?й|-?е)?\\s*(?:квартал|полугоди)[а-яё]*(?:\\s+(?:19|20)\\d{2}(?:\\s*год[а-яё]*)?)?',
      // конец/начало/середина недели/месяца/года
      '(?:до\\s+)?(?:конц|начал|середин)[а-яё]*\\s+(?:недел|месяц|год|лет)[а-яё]*',
      // дни недели
      '(?:в\\s+|во\\s+)?(?:понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея])',
      // время: 10:00, 10:30:15, 10:00 утра
      '\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*(?:утра|дня|вечера|ночи))?',
      // относительные слова (NER иногда метит их как DATE)
      'сегодня|завтра|вчера|послезавтра|позавчера|на\\s+(?:этой|следующей|прошлой)\\s+неделе',
    ].join('|') +
  ')\\s*$',
  'i',
);

/** Метки анонимайзера, которые всегда означают дату/время. */
const DATE_LABEL_RE = /^(?:DATE|TIME|DATETIME|YEAR|MONTH|DAY|PERIOD|QUARTER|DEADLINE)/;

/**
 * Родовые слова, которые сервис анонимизации помечает как организации и людей.
 * Маскировать их бессмысленно (ничего не раскрывают) и вредно: после обратной
 * подстановки в протоколе появляются «Заказчик — организация заказчика» и
 * «Заявку в организацию учреждение направлено» — исходная форма слова
 * вставляется в чужой падеж.
 *
 * Фильтр живёт ЗДЕСЬ, на стороне протоколера, а не только в анонимизаторе:
 * сервис теперь общий и его код нам не подчиняется.
 */
const GENERIC_ENTITY_WORDS = new Set([
  'заказчик', 'исполнитель', 'подрядчик', 'поставщик', 'клиент',
  'участник', 'участники', 'представитель', 'представители',
  'сотрудник', 'сотрудники', 'коллега', 'коллеги', 'спикер',
  'директор', 'руководитель', 'начальник', 'специалист', 'аналитик',
  'команда', 'команды', 'сторона', 'стороны', 'пользователь',
  'организация', 'организации', 'учреждение', 'учреждения',
  'компания', 'компании', 'фирма', 'предприятие', 'отдел',
  'департамент', 'служба', 'офис', 'филиал', 'подразделение',
  'город', 'область', 'район', 'адрес', 'чат',
  'протокол', 'договор', 'проект', 'система', 'программа', 'документ',
]);

/** Родовое ли это слово (в любом падеже). */
export function isGenericEntityValue(value: string): boolean {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/^[«"'([]+|[»"')\].,;:!?—–-]+$/gu, '')
    .toLowerCase()
    .replace(/ё/g, 'е');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => {
    for (const g of GENERIC_ENTITY_WORDS) {
      if (w === g) return true;
      // Падежи отсекаем по началу слова: «учреждению», «заказчика».
      if (w.length > 4 && g.length >= 5 && w.startsWith(g.slice(0, 5))) return true;
    }
    return false;
  });
}

function isNonSensitiveValue(placeholder: string, value: string): boolean {
  const label = labelOf(placeholder).toUpperCase();
  const v = String(value ?? '').trim();
  if (!v) return false;
  if (DATE_LABEL_RE.test(label) || DATE_VALUE_RE.test(v)) return true;
  if (isGenericEntityValue(v)) return true;
  return NON_SENSITIVE_PHRASES.has(v.toLowerCase());
}

/**
 * Убирает из mapping всё, что маскировать не нужно (даты, родовые слова), и
 * возвращает оригиналы в тексте. Без чистки САМОГО mapping плейсхолдеры
 * остаются в окне подтверждения и всплывают при деанонимизации ответа.
 */
export function dropNonSensitiveEntries(
  text: string,
  mapping: Record<string, string>,
): { text: string; mapping: Record<string, string>; dropped: string[] } {
  const nextMapping: Record<string, string> = {};
  const dropped: string[] = [];
  let out = text;

  for (const [ph, original] of Object.entries(mapping)) {
    if (isNonSensitiveValue(ph, original)) {
      if (out.includes(ph)) out = out.split(ph).join(original);
      dropped.push(`${ph}=«${original}»`);
      continue;
    }
    nextMapping[ph] = original;
  }

  return { text: out, mapping: nextMapping, dropped };
}

/**
 * Возвращает в анонимизированный текст оригиналы для «неконфиденциальных»
 * плейсхолдеров (даты, приветствия/служебные слова). Остальное не трогает.
 */
export function restoreNonSensitivePlaceholders(
  text: string,
  mapping: Record<string, string>,
): { text: string; restored: number } {
  if (!text) return { text, restored: 0 };
  let out = text;
  let restored = 0;
  for (const [ph, original] of Object.entries(mapping)) {
    if (!isNonSensitiveValue(ph, original)) continue;
    if (out.includes(ph)) {
      out = out.split(ph).join(original);
      restored += 1;
    }
  }
  return { text: out, restored };
}
