/**
 * Работа с датами протокола: контекст «сегодня» для промптов и детерминированный
 * перевод относительных выражений («в четверг», «до конца недели») в ДД.ММ.ГГГГ.
 *
 * Модель этого надёжно не делает: то оставляет «в четверг», то подставляет
 * сегодняшнюю дату как дату встречи. Поэтому дату считает код, а модель только
 * получает справку о текущем дне.
 */

export const DAY_NAMES_RU = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const;

/** Именительный падеж → индекс дня недели (0 = воскресенье). */
const WEEKDAY_INDEX: Record<string, number> = {
  воскресенье: 0,
  понедельник: 1,
  вторник: 2,
  среда: 3,
  четверг: 4,
  пятница: 5,
  суббота: 6,
};

/** Формы дня недели, которые встречаются в тексте («в четверг», «во вторник»). */
const WEEKDAY_FORMS: Array<{ rx: string; index: number }> = [
  { rx: 'понедельник', index: 1 },
  { rx: 'вторник', index: 2 },
  { rx: 'сред[ауы]', index: 3 },
  { rx: 'четверг', index: 4 },
  { rx: 'пятниц[ауы]', index: 5 },
  { rx: 'суббот[ауы]', index: 6 },
  { rx: 'воскресень[ея]', index: 0 },
];

export function formatRuDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/** «23.07.2026» → Date. Невалидная строка → null. */
export function parseRuDate(value?: string | null): Date | null {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  return d;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/** Ближайший указанный день недели СТРОГО после anchor. */
function nextWeekday(anchor: Date, weekday: number): Date {
  const diff = (weekday - anchor.getDay() + 7) % 7;
  return addDays(anchor, diff === 0 ? 7 : diff);
}

/** Понедельник недели, в которую попадает дата (неделя начинается с понедельника). */
function startOfWeek(d: Date): Date {
  const shift = (d.getDay() + 6) % 7;
  return addDays(d, -shift);
}

/** Пятница той же недели; если она уже позади — воскресенье той же недели. */
function endOfWeek(anchor: Date): Date {
  const friday = addDays(startOfWeek(anchor), 4);
  if (friday.getTime() >= anchor.getTime()) return friday;
  return addDays(startOfWeek(anchor), 6);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export type DateResolution = { from: string; to: string };

/** Порядковые числительные 1–31 во всех падежах, которые встречаются в речи. */
const ORDINAL_DAYS: Record<string, number> = (() => {
  const stems = [
    'перв', 'втор', 'трет', 'четвёрт', 'четверт', 'пят', 'шест', 'седьм', 'восьм',
    'девят', 'десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат',
    'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат',
    'двадцат', 'двадцать перв', 'двадцать втор', 'двадцать трет',
    'двадцать четвёрт', 'двадцать четверт', 'двадцать пят', 'двадцать шест',
    'двадцать седьм', 'двадцать восьм', 'двадцать девят', 'тридцат',
    'тридцать перв',
  ];
  // Индексы стволов → число. Дубли («четвёрт»/«четверт») нумеруются вручную.
  const numbers = [
    1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 24, 25, 26, 27, 28, 29, 30, 31,
  ];
  const endings = ['ого', 'его', 'ое', 'ый', 'ий', 'ому', 'ему', 'ым', 'им'];
  const map: Record<string, number> = {};
  stems.forEach((stem, i) => {
    for (const e of endings) map[`${stem}${e}`] = numbers[i];
  });
  return map;
})();

const MONTHS_RU: Record<string, number> = {
  январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6,
  июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};

const SPELLED_DATE_RX = new RegExp(
  `(?<![\\p{L}])((?:двадцать |тридцать )?[а-яё]+(?:ого|его|ое|ый|ий|ому|ему|ым|им))\\s+` +
    `(январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-яё]*`,
  'giu',
);

/**
 * «до пятнадцатого октября» → «до 15.10.2026».
 *
 * Зачем кодом, а не промптом: проверено на стенде трижды подряд — модель либо
 * оставляет число словами, либо считает такую формулировку ОТСУТСТВИЕМ срока и
 * ставит «подлежит уточнению», либо вовсе выбрасывает дату из пересказа. Три
 * разные правки промпта (регламент, промпт чат-агента, промпт документного
 * агента) результата не дали. Разбор порядкового числительного — детерминируемая
 * задача, у кода она получается точно, у LLM — нет.
 *
 * Год берётся от anchor (дата встречи). Если названный месяц раньше месяца
 * встречи более чем на 6 месяцев — значит, речь о следующем годе: «встреча в
 * декабре, срок до пятнадцатого февраля» — это февраль следующего года.
 */
export function normalizeSpelledDates(
  text: string,
  anchor: Date,
): { text: string; resolutions: DateResolution[] } {
  if (!text) return { text, resolutions: [] };
  const resolutions: DateResolution[] = [];
  const out = text.replace(SPELLED_DATE_RX, (match, dayWord: string, monthStem: string) => {
    const day = ORDINAL_DAYS[String(dayWord).toLowerCase()];
    const month = MONTHS_RU[String(monthStem).toLowerCase()];
    if (!day || !month) return match;

    let year = anchor.getFullYear();
    const monthsBack = anchor.getMonth() + 1 - month;
    if (monthsBack > 6) year += 1;

    const formatted = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
    resolutions.push({ from: match, to: formatted });
    return formatted;
  });
  return { text: out, resolutions };
}

/**
 * Заменяет относительные выражения конкретными датами, считая от anchor
 * (даты встречи). Неоднозначные обороты («скоро», «в ближайшее время»)
 * не трогает — их дальше пометит flagRelativeDates.
 */
export function resolveRelativeDatesInText(
  text: string,
  anchor: Date,
): { text: string; resolutions: DateResolution[] } {
  if (!text) return { text, resolutions: [] };
  const resolutions: DateResolution[] = [];
  let out = text;

  const replace = (
    rx: RegExp,
    compute: (match: string) => Date | null,
    /**
     * Предлог перед датой. Строка — фиксированный («до конца недели» → «до дата»).
     * 'keep' — сохранить тот, что был в тексте («назначена НА четверг» → «назначена НА дата»),
     * иначе фраза теряет грамматику.
     */
    prefix: string | 'keep' = '',
  ) => {
    out = out.replace(rx, (match) => {
      const date = compute(match);
      if (!date) return match;
      const formatted = formatRuDate(date);
      resolutions.push({ from: match.trim(), to: formatted });
      if (prefix === 'keep') {
        // «назначена НА четверг» → «назначена НА дату» (предлог нужен),
        // «встреча В четверг» → «встреча 30.07.2026» (с датой предлог лишний).
        // \b в JS не работает с кириллицей — граница слова только для латиницы.
        const prep = match.trim().match(/^на\s/i);
        return prep ? `на ${formatted}` : formatted;
      }
      return prefix ? `${prefix} ${formatted}` : formatted;
    });
  };

  // «в четверг», «во вторник», «на четверг» («встреча назначена на четверг»),
  // «в следующий понедельник», «в ближайшую пятницу».
  for (const { rx, index } of WEEKDAY_FORMS) {
    replace(
      new RegExp(
        `(?<![\\p{L}])(?:в|во|на)\\s+(?:следующ[ийуюего]{2,3}\\s+|ближайш[ийуюего]{2,3}\\s+)?${rx}(?![\\p{L}])`,
        'giu',
      ),
      () => nextWeekday(anchor, index),
      'keep',
    );
  }

  replace(/(?<![\p{L}])позавчера(?![\p{L}])/giu, () => addDays(anchor, -2));
  replace(/(?<![\p{L}])вчера(?![\p{L}])/giu, () => addDays(anchor, -1));
  replace(/(?<![\p{L}])сегодня(?![\p{L}])/giu, () => anchor);
  replace(/(?<![\p{L}])послезавтра(?![\p{L}])/giu, () => addDays(anchor, 2));
  replace(/(?<![\p{L}])завтра(?![\p{L}])/giu, () => addDays(anchor, 1));

  replace(
    /(?<![\p{L}])(?:до конца недели|на этой неделе|в течение недели)(?![\p{L}])/giu,
    () => endOfWeek(anchor),
    'до',
  );
  replace(
    /(?<![\p{L}])на следующей неделе(?![\p{L}])/giu,
    () => endOfWeek(addDays(startOfWeek(anchor), 7)),
    'до',
  );
  replace(
    /(?<![\p{L}])(?:до конца месяца|в конце месяца)(?![\p{L}])/giu,
    () => endOfMonth(anchor),
    'до',
  );

  return { text: out, resolutions };
}

/**
 * Справка о текущей дате для системного промпта.
 * Явно разделяет «сегодня» и «дату встречи» — иначе модель подставляет
 * сегодняшнее число в шапку протокола.
 */
export function buildDateContextBlock(now: Date = new Date()): string {
  const dayName = DAY_NAMES_RU[now.getDay()];
  return (
    `\n\n[КОНТЕКСТ ДАТЫ: Сегодня — ${formatRuDate(now)} (${dayName}). ` +
    'Это дата ОБРАБОТКИ протокола, а НЕ дата встречи: не подставляй её в поле даты встречи. ' +
    'Дату встречи бери только из расшифровки или из ответа пользователя; если её нет — пиши «требует уточнения». ' +
    'Сегодняшняя дата нужна только для понимания дня недели при переводе относительных сроков в конкретные даты.]'
  );
}

export { WEEKDAY_INDEX };
