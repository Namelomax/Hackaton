/**
 * Детерминированные «предохранители» для финального протокола.
 *
 * Слабые модели регулярно: выдумывают сроки, теряют должности, оставляют тайм-коды.
 * Промптом это не лечится надёжно — поэтому здесь код-проверки, которые применяются
 * к УЖЕ собранному протоколу перед выводом в DOCX. Все функции чистые и тестируемые.
 */
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { parseRuDate, formatRuDate, resolveRelativeDatesInText } from '@/lib/date-context';

/** Единая формулировка незаполненного места во всём документе. */
export const UNRESOLVED_MARKER = 'требует уточнения';

/**
 * Корни названий месяцев для разбора словесных дат («1 марта 2026», «24 февраля
 * 2028 г.»). Падежные окончания добираются регэкспом `[а-яёА-ЯЁ]*` после корня —
 * так распознаются любые формы («марта», «марте», «март»).
 */
const MONTH_ROOTS: Array<{ rx: string; month: number }> = [
  { rx: 'январ', month: 1 },
  { rx: 'феврал', month: 2 },
  { rx: 'март', month: 3 },
  { rx: 'апрел', month: 4 },
  { rx: 'ма[йя]', month: 5 },
  { rx: 'июн', month: 6 },
  { rx: 'июл', month: 7 },
  { rx: 'август', month: 8 },
  { rx: 'сентябр', month: 9 },
  { rx: 'октябр', month: 10 },
  { rx: 'ноябр', month: 11 },
  { rx: 'декабр', month: 12 },
];

const MONTH_ALT_RX = MONTH_ROOTS.map((m) => m.rx).join('|');

/** Определяет номер месяца по слову, начинающемуся с одного из MONTH_ROOTS. */
function monthFromWord(word: string): number {
  const w = String(word || '').toLowerCase();
  for (const { rx, month } of MONTH_ROOTS) {
    if (new RegExp(`^(?:${rx})`, 'i').test(w)) return month;
  }
  return 0;
}

/** Словесная дата: «1 марта 2026», «01 марта 2026 года», «24 февраля 2028 г.». */
const WORDY_DATE_RX = new RegExp(`\\b(\\d{1,2})\\s+((?:${MONTH_ALT_RX})[а-яёА-ЯЁ]*)\\s+(\\d{4})\\b`, 'gi');

/**
 * Единая дата (цифровая ИЛИ словесная) с прилегающим контекстом — используется
 * в enforceDateProvenance для замены даты БЕЗ поломки грамматики фразы.
 * Группы: 1 — «Срок:», 2 — предлог/оборот перед датой, 3-5 — дд.мм.гггг (цифры),
 * 6-8 — дд, слово месяца, гггг (словесная форма).
 */
const CONTEXTUAL_DATE_RX = new RegExp(
  '(Срок:\\s*)?' +
    '((?:в срок\\s+)?(?:до|к|с|по|не позднее)\\s+)?' +
    '\\b' +
    `(?:(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})|(\\d{1,2})\\s+((?:${MONTH_ALT_RX})[а-яёА-ЯЁ]*)\\s+(\\d{4}))` +
    '(?:\\s*г\\.|\\s+года)?',
  'gi',
);

/** Удаляет любые маркеры тайм-кодов [ТС: …], [TC: …], {{ТС: …}} (в т.ч. «[ТС: Не указано…]»). */
export function stripTimecodes(text: string): string {
  if (!text) return text;
  return text
    .replace(/\{\{\s*[ТT][СC]\s*:[^}]*\}\}/gi, '')
    .replace(/\[\s*[ТT][СC]\s*:[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

/** Зачищает тайм-коды во всех текстовых полях протокола (в финале их быть не должно). */
export function stripProtocolTimecodes(p: Protocol): Protocol {
  return {
    ...p,
    protocolTitle: stripTimecodes(p.protocolTitle),
    agenda: { items: p.agenda.items.map(stripTimecodes) },
    participants: {
      customer: { ...p.participants.customer, people: p.participants.customer.people.map((x) => ({ fullName: stripTimecodes(x.fullName), position: stripTimecodes(x.position) })) },
      executor: { ...p.participants.executor, people: p.participants.executor.people.map((x) => ({ fullName: stripTimecodes(x.fullName), position: stripTimecodes(x.position) })) },
    },
    meetingContent: {
      topics: p.meetingContent.topics.map((t) => ({
        title: stripTimecodes(t.title), listened: stripTimecodes(t.listened),
        discussed: stripTimecodes(t.discussed), decided: stripTimecodes(t.decided),
      })),
      summary: p.meetingContent.summary.map((r) => ({ question: stripTimecodes(r.question), decision: stripTimecodes(r.decision) })),
    },
  };
}

/**
 * Все даты из текста в НОРМАЛИЗОВАННОМ виде `d.m.yyyy` — независимо от того,
 * как их написал человек: «02.02.2025», «2.2.2025», «02/02/2025», «02-02-2025»
 * и слитно «02022025» (пользователи часто отвечают датами без точек).
 */
function extractNormalizedDates(text: string): Set<string> {
  const out = new Set<string>();
  const add = (dd: string, mm: string, yy: string) => {
    const d = Number(dd);
    const m = Number(mm);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) out.add(`${d}.${m}.${yy}`);
  };
  for (const m of text.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)) add(m[1], m[2], m[3]);
  for (const m of text.matchAll(/\b(\d{2})(\d{2})(\d{4})\b/g)) add(m[1], m[2], m[3]); // ддммгггг
  for (const m of text.matchAll(WORDY_DATE_RX)) {
    const month = monthFromWord(m[2]);
    if (month) add(m[1], String(month), m[3]);
  }
  return out;
}

const normKey = (dd: string, mm: string, yy: string) => `${Number(dd)}.${Number(mm)}.${yy}`;

export interface DateProvenanceResult { protocol: Protocol; unresolved: string[]; }

/**
 * Любая дата в «Решили»/«Резюме», которой НЕТ в расшифровке или ответах пользователя,
 * считается выдуманной → заменяется на «подлежит уточнению». Возвращает список таких мест.
 *
 * @param userTexts — сообщения пользователя (правки/ответы). Даты из них
 *   ПРИВИЛЕГИРОВАННЫЕ: пользователь назвал их явно, поэтому они разрешены как
 *   сроки даже при совпадении с датой встречи/договора и в любом формате записи.
 */
export function enforceDateProvenance(
  p: Protocol,
  sourceText: string,
  userTexts: string[] = [],
): DateProvenanceResult {
  const unresolved: string[] = [];
  const sourceDates = extractNormalizedDates(sourceText || '');
  const userDates = extractNormalizedDates(userTexts.join('\n'));

  // Дата встречи и дата договора запрещены как срок решения (слабая модель
  // копирует их на все пункты) — НО только если пользователь не назвал эту дату
  // явно сам (тогда это его осознанный ответ, а не копирование моделью).
  const forbidden = new Set<string>();
  const addForbidden = (d?: string) => {
    const m = String(d || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) forbidden.add(normKey(m[1], m[2], m[3]));
  };
  addForbidden(p.meetingDate);
  addForbidden(p.contractDate);

  // Дату заменяем ВМЕСТЕ с прилегающим контекстом (иначе получается битая
  // грамматика вида «переход на ЭДО с подлежит уточнению»):
  // - «Срок: 01.03.2026» → «Срок: подлежит уточнению» (формат нужен downstream-проверкам);
  // - «до/к/с/по/не позднее 01.03.2026» → предлог поглощается, «в срок, подлежащий уточнению»;
  // - голая дата в середине фразы → тоже «в срок, подлежащий уточнению»;
  // - хвост «г.»/«года» поглощается в обоих случаях.
  const fix = (text: string, label: string): string =>
    (text || '').replace(
      CONTEXTUAL_DATE_RX,
      (whole, srok, _prep, dd1, mm1, yy1, dd2, monthWord, yy2) => {
        const isWordy = dd2 !== undefined;
        const dd = isWordy ? dd2 : dd1;
        const mm = isWordy ? String(monthFromWord(monthWord)) : mm1;
        const yy = isWordy ? yy2 : yy1;
        if (!mm || Number(mm) < 1) return whole; // корень месяца не распознан — не трогаем

        const key = normKey(dd, mm, yy);
        if (userDates.has(key)) return whole; // пользователь назвал дату явно

        const display = `${Number(dd)}.${Number(mm)}.${yy}`;
        let reason: string | null = null;
        if (forbidden.has(key)) {
          reason = `${label}: дата встречи/договора (${display}) использована как срок — заменена на «подлежит уточнению»`;
        } else if (!sourceDates.has(key)) {
          reason = `${label}: дата ${display} отсутствует в расшифровке/ответах — заменена на «подлежит уточнению»`;
        }
        if (!reason) return whole; // дата подтверждена расшифровкой — не трогаем

        unresolved.push(reason);
        return srok ? 'Срок: подлежит уточнению' : 'в срок, подлежащий уточнению';
      },
    );

  const topics = p.meetingContent.topics.map((t) => ({ ...t, decided: fix(t.decided, t.title || 'Решение') }));
  const summary = p.meetingContent.summary.map((r) => ({ ...r, decision: fix(r.decision, r.question || 'Резюме') }));
  // Одно и то же решение проверяется в «Решили» и в «Резюме» — предупреждения дедупим.
  return { protocol: { ...p, meetingContent: { topics, summary } }, unresolved: [...new Set(unresolved)] };
}

const NO_POSITION_RX = /^\s*$|^не\s+указан/i;

/** Ищет роль участника в исходнике по шаблону «ФИО, <роль>». Консервативно. */
function findRoleInSource(name: string, source: string): string {
  if (!name) return '';
  const idx = source.indexOf(name);
  if (idx < 0) return '';
  const after = source.slice(idx + name.length, idx + name.length + 90);
  const m = after.match(/^\s*[,—–-]\s*([А-Яа-яЁё][^.\n,;]{4,70})/);
  return m ? m[1].trim() : '';
}

/** Если у участника пустая/«не указана» должность, а в исходнике роль есть — подставляет её. */
export function carryOverParticipantRoles(p: Protocol, sourceText: string): Protocol {
  const src = sourceText || '';
  const fixPeople = (people: Protocol['participants']['customer']['people']) =>
    people.map((x) => {
      if (!NO_POSITION_RX.test(x.position)) return x;
      const role = findRoleInSource(x.fullName, src);
      return role ? { ...x, position: role } : x;
    });
  return {
    ...p,
    participants: {
      customer: { ...p.participants.customer, people: fixPeople(p.participants.customer.people) },
      executor: { ...p.participants.executor, people: fixPeople(p.participants.executor.people) },
    },
  };
}

/**
 * Финальная сверка: что из подтверждённого в чате / поздних правок НЕ попало в документ,
 * и какие сроки остались неконкретными. Возвращает список предупреждений (пустой = ок).
 */
export function reconcileWithApproved(
  p: Protocol,
  chatDraft: Partial<Protocol>,
  userCorrections: string[] = [],
): string[] {
  const warnings: string[] = [];
  const allText = JSON.stringify(p).toLowerCase();

  // Договор обязателен в шапке.
  const hasContract = (p.contractNumber && p.contractNumber.trim() && !/^№?\s*$/.test(p.contractNumber.trim())) ||
    (p.contractSubject && p.contractSubject.trim().length > 0);
  if (!hasContract) warnings.push('В документе не заполнен договор (№ и/или тема) — уточните и заполните шапку.');

  // 1. Подтверждённые пункты повестки на месте?
  for (const item of chatDraft.agenda?.items ?? []) {
    const head = item.trim().toLowerCase().slice(0, 25);
    if (head && !allText.includes(head)) warnings.push(`Пункт повестки из чата отсутствует в документе: «${item}»`);
  }
  // 2. Подтверждённые участники на месте?
  const draftPeople = [
    ...(chatDraft.participants?.customer.people ?? []),
    ...(chatDraft.participants?.executor.people ?? []),
  ];
  for (const person of draftPeople) {
    const nm = person.fullName.trim().toLowerCase();
    if (nm && !allText.includes(nm)) warnings.push(`Участник из чата отсутствует в документе: «${person.fullName}»`);
  }
  // 3. Сроки/ответственные конкретны?
  p.meetingContent.summary.forEach((r) => {
    if (!/срок\s*:/i.test(r.decision)) warnings.push(`В резюме нет «Срок:» по вопросу «${r.question}»`);
    if (/подлеж(?:ит|ащ[а-яё]*)\s+уточнени/i.test(r.decision)) warnings.push(`Срок не подтверждён по вопросу «${r.question}» — уточните дату`);
    if (!/ответствен/i.test(r.decision)) warnings.push(`Нет ответственного по вопросу «${r.question}»`);
  });
  // 4. Поздние правки пользователя — напоминание проверить вручную.
  if (userCorrections.length > 0) {
    warnings.push(`После согласования были правки пользователя (${userCorrections.length}) — проверьте, что они учтены.`);
  }
  return warnings;
}

const REAL_RX = /\S/;
function realStr(v?: string): boolean {
  return Boolean(v && REAL_RX.test(v) && !/^не\s+указан/i.test(v.trim()));
}

/**
 * Если модель «потеряла» договор, достаём его из ответов пользователя в диалоге.
 * Сканируем ВСЕ окна вокруг слова «договор» (первое упоминание — обычно вопрос
 * агента без данных; ответ пользователя «Договор: номер 1, дата 01012025, тема …»
 * встречается позже). Только ЗАПОЛНЯЕМ пустое, не перезаписываем.
 */
export function fillContractFromDialogue(p: Protocol, dialogueText: string): Protocol {
  const t = String(dialogueText || '');
  const out: Protocol = { ...p };

  for (const winMatch of t.matchAll(/догов[а-яёА-ЯЁ]*[\s\S]{0,140}/gi)) {
    const win = winMatch[0];

    if (!realStr(out.contractNumber)) {
      // Разделители допустимы и до, и после ключевого слова: «Договор: номер 1»,
      // «договор № 1», «номер договора — 1».
      const m = win.match(
        /догов[а-яёА-ЯЁ]*\s*[:\-—]?\s*(?:№|n|номер[а-яёА-ЯЁ]*)?\s*[:\-—]?\s*(\d{1,6})(?!\d)/i,
      );
      if (m) out.contractNumber = `№${m[1]}`;
    }
    if (!realStr(out.contractDate)) {
      const m = win.match(/(?:дата|от)\s*[:\-—]?\s*(\d{1,2})[.\-/]?(\d{1,2})[.\-/]?(\d{4})/i);
      if (m) out.contractDate = `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3]}`;
    }
    if (!realStr(out.contractSubject)) {
      const m = win.match(/тема\s*(?:догов[а-яёА-ЯЁ]*)?\s*[:\-—]?\s*([^.\n;]{3,80})/i);
      if (m) out.contractSubject = m[1].trim();
    }

    if (realStr(out.contractNumber) && realStr(out.contractDate) && realStr(out.contractSubject)) {
      break; // всё найдено
    }
  }
  return out;
}

/**
 * Восстанавливает поля ШАПКИ (номер и название протокола) из ответов в диалоге,
 * если модель их «потеряла». Только ЗАПОЛНЯЕТ пустое, не перезаписывает.
 * Берём последнее валидное упоминание (обычно подтверждённое предложение агента).
 */
export function fillHeaderFromDialogue(p: Protocol, dialogueText: string): Protocol {
  const t = String(dialogueText || '');
  const out: Protocol = { ...p };

  // Номер протокола: «протокол №1», «номер протокола 1», «протокол номер 1».
  const numEmpty = !realStr(out.protocolNumber) || /^№?\s*$/.test(String(out.protocolNumber).trim());
  if (numEmpty) {
    let lastNum = '';
    for (const m of t.matchAll(/протокол[а-яё]*\s*(?:№|номер[а-яё]*)\s*[:\-—]?\s*(\d{1,4})(?!\d)/gi)) {
      lastNum = m[1];
    }
    if (lastNum) out.protocolNumber = `№${lastNum}`;
  }

  // Название/тема протокола: «название протокола: X» / «тема протокола — X».
  // Отсекаем служебные фрагменты вопроса агента (списки «1) …; 2) …», слово «договор»).
  if (!realStr(out.protocolTitle)) {
    let lastTitle = '';
    for (const m of t.matchAll(
      /(?:назван[а-яё]*|тема|наименован[а-яё]*)\s+протокол[а-яё]*\s*[:\-—]\s*«?([^.\n;»)]{3,120})»?/gi,
    )) {
      const cand = m[1].trim();
      if (cand && !/догов|\bнеобходимо\b|уточн/i.test(cand) && !/^\d+[).]/.test(cand)) {
        lastTitle = cand;
      }
    }
    if (lastTitle) out.protocolTitle = lastTitle;
  }

  return out;
}

// --- Относительные даты в финальном документе (просьба заказчика, п.3) ---
// «сегодня», «вчера», «на следующей неделе» и т.п. не подходят для протокола.
// Модель обязана заменять их конкретными датами, но слабая модель иногда
// пропускает. Здесь детерминированно помечаем такие места прямо В ТЕКСТЕ
// документа маркером «(⚠️ требует уточнения: конкретная дата)».
const RELATIVE_DATE_IN_DOC_RX = new RegExp(
  '(?<![\\p{L}\\p{N}])(' +
    [
      'сегодня', 'вчера', 'завтра', 'послезавтра', 'позавчера',
      'на следующей неделе', 'на прошлой неделе', 'на этой неделе',
      'до конца недели', 'до конца месяца', 'в конце месяца', 'в начале месяца',
      'в ближайшее время', 'в ближайшие дни', 'на днях', 'скоро',
      'в течение недели', 'в течение месяца',
    ].join('|') +
  ')(?![\\p{L}\\p{N}])',
  'giu',
);
const ALREADY_FLAGGED = '(⚠️ требует уточнения: конкретная дата)';

function flagRelativeInText(text: string, label: string, flags: string[]): string {
  if (!text || text.includes(ALREADY_FLAGGED)) return text;
  return text.replace(RELATIVE_DATE_IN_DOC_RX, (m) => {
    flags.push(`${label}: относительная дата «${m}» — требуется конкретная дата ДД.ММ.ГГГГ`);
    return `${m} ${ALREADY_FLAGGED}`;
  });
}

/**
 * Переводит относительные выражения в конкретные даты, считая от даты встречи.
 * Работает ДО flagRelativeDates: что удалось вычислить — станет датой, что не
 * удалось («скоро», «в ближайшее время») — уйдёт под маркер уточнения.
 * Все вычисленные даты возвращаются списком, чтобы показать их пользователю:
 * это расчёт кода, а не факт из расшифровки, и его нужно подтвердить.
 */
export function resolveRelativeDates(p: Protocol): { protocol: Protocol; notes: string[] } {
  const anchor = parseRuDate(p.meetingDate);
  if (!anchor) return { protocol: p, notes: [] };

  const notes: string[] = [];
  const fix = (text: string, label: string): string => {
    if (!text) return text;
    const { text: next, resolutions } = resolveRelativeDatesInText(text, anchor);
    for (const r of resolutions) {
      notes.push(`${label}: «${r.from}» → ${r.to} (рассчитано от даты встречи ${p.meetingDate}) — проверьте`);
    }
    return next;
  };

  const topics = p.meetingContent.topics.map((t) => ({
    ...t,
    discussed: fix(t.discussed, t.title || 'Обсудили'),
    decided: fix(t.decided, t.title || 'Решили'),
  }));
  const summary = p.meetingContent.summary.map((r) => ({
    ...r,
    decision: fix(r.decision, r.question || 'Резюме'),
  }));

  return {
    protocol: { ...p, meetingContent: { topics, summary } },
    notes: [...new Set(notes)],
  };
}

/**
 * Дата встречи, взятая «с потолка». Типовой сбой: модель видит в системном
 * промпте сегодняшнюю дату и ставит её в шапку, хотя в расшифровке даты нет.
 * Если дата встречи равна сегодняшней и при этом не встречается ни в
 * расшифровке, ни в ответах пользователя — это выдумка.
 */
export function dropInventedMeetingDate(
  p: Protocol,
  sourceText: string,
  userTexts: string[] = [],
  today: Date = new Date(),
): { protocol: Protocol; note: string | null } {
  const meeting = parseRuDate(p.meetingDate);
  if (!meeting) return { protocol: p, note: null };
  if (formatRuDate(meeting) !== formatRuDate(today)) return { protocol: p, note: null };

  const known = new Set([
    ...extractNormalizedDates(sourceText || ''),
    ...extractNormalizedDates(userTexts.join('\n')),
  ]);
  const key = `${meeting.getDate()}.${meeting.getMonth() + 1}.${meeting.getFullYear()}`;
  if (known.has(key)) return { protocol: p, note: null };

  return {
    protocol: { ...p, meetingDate: UNRESOLVED_MARKER },
    note: `Дата встречи: в расшифровке её нет, подставлена сегодняшняя (${p.meetingDate}) — заменена на «${UNRESOLVED_MARKER}», уточните`,
  };
}

/** «№№14», «№ №14», «No14» в номерах → чистый номер: рендер сам добавит «№». */
export function normalizeProtocolNumbers(p: Protocol): Protocol {
  const clean = (value?: string) => {
    const s = String(value ?? '').trim();
    if (!s) return value;
    return s.replace(/^(?:№|N[оo]?|#)\s*/i, '').replace(/^(?:№|N[оo]?|#)\s*/i, '').trim();
  };
  return {
    ...p,
    protocolNumber: clean(p.protocolNumber) ?? p.protocolNumber,
    ...(p.contractNumber ? { contractNumber: clean(p.contractNumber) } : {}),
  };
}

/**
 * Единый маркер незаполненного места. Модель произвольно чередует «требует
 * уточнения» и «подлежит уточнению» в одном документе — заказчику это видно
 * как небрежность.
 */
export function unifyUnresolvedMarkers(p: Protocol): Protocol {
  const fix = (value: unknown): any => {
    if (typeof value === 'string') {
      return value
        .replace(/подлежащ(ий|ая|ее|ие|его|ую)\s+уточнени[юя]/gi, 'требующий уточнения')
        .replace(/подлежит\s+уточнению/gi, UNRESOLVED_MARKER)
        .replace(/нужд[а-яё]*\s+в\s+уточнении/gi, UNRESOLVED_MARKER);
    }
    if (Array.isArray(value)) return value.map(fix);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fix(v);
      return out;
    }
    return value;
  };
  return fix(p) as Protocol;
}

/** Основа имени без падежного окончания: «Сергея» и «Сергей» → «Серге». */
function nameStem(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/\s+/)
    .map((word) => word.replace(/[аеиоуыэюяйь]$/i, ''))
    .join(' ');
}

/**
 * Убирает дубли участников, появившиеся из-за падежей: пользователь пишет
 * «Сергея включай», модель заводит и «Сергей», и «Сергея». Оставляем первую
 * запись, при равенстве основ предпочитаем ту, у которой заполнена должность.
 */
export function dedupeParticipants(p: Protocol): { protocol: Protocol; notes: string[] } {
  const notes: string[] = [];
  const dedupeList = (list: any[] | undefined, side: string) => {
    if (!Array.isArray(list)) return list;
    const byStem = new Map<string, any>();
    for (const row of list) {
      const stem = nameStem(row?.fullName ?? '');
      if (!stem) continue;
      const existing = byStem.get(stem);
      if (!existing) {
        byStem.set(stem, row);
        continue;
      }
      // ФИО берём из ПЕРВОЙ записи: она пришла из расшифровки и стоит в
      // именительном падеже, тогда как дубль обычно родился из склонения в
      // сообщении пользователя («Сергея включай»). Должность добираем из той
      // записи, где она заполнена.
      const existingHasPosition = !NO_POSITION_RX.test(String(existing?.position ?? ''));
      const rowHasPosition = !NO_POSITION_RX.test(String(row?.position ?? ''));
      const keep = existingHasPosition || !rowHasPosition
        ? existing
        : { ...existing, position: row.position };
      byStem.set(stem, keep);
      notes.push(
        `Участники (${side}): «${row?.fullName}» — дубль «${existing?.fullName}» в другом падеже, удалён`,
      );
    }
    return [...byStem.values()];
  };

  const participants: any = { ...(p as any).participants };
  if (Array.isArray(participants?.customer?.people)) {
    participants.customer = {
      ...participants.customer,
      people: dedupeList(participants.customer.people, 'Заказчик'),
    };
  }
  if (Array.isArray(participants?.executor?.people)) {
    participants.executor = {
      ...participants.executor,
      people: dedupeList(participants.executor.people, 'Исполнитель'),
    };
  }
  return { protocol: { ...p, participants }, notes: [...new Set(notes)] };
}

/** Помечает относительные даты в содержательных полях протокола. */
export function flagRelativeDates(p: Protocol): { protocol: Protocol; flags: string[] } {
  const flags: string[] = [];
  const topics = p.meetingContent.topics.map((t) => ({
    ...t,
    discussed: flagRelativeInText(t.discussed, t.title || 'Обсудили', flags),
    decided: flagRelativeInText(t.decided, t.title || 'Решили', flags),
  }));
  const summary = p.meetingContent.summary.map((r) => ({
    ...r,
    decision: flagRelativeInText(r.decision, r.question || 'Резюме', flags),
  }));
  return { protocol: { ...p, meetingContent: { topics, summary } }, flags };
}
