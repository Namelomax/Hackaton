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
