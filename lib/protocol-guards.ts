/**
 * Детерминированные «предохранители» для финального протокола.
 *
 * Слабые модели регулярно: выдумывают сроки, теряют должности, оставляют тайм-коды.
 * Промптом это не лечится надёжно — поэтому здесь код-проверки, которые применяются
 * к УЖЕ собранному протоколу перед выводом в DOCX. Все функции чистые и тестируемые.
 */
import type { Protocol } from '@/lib/schemas/protocol-schema';

const FULL_DATE_RX = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;

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

  const fix = (text: string, label: string): string =>
    (text || '').replace(FULL_DATE_RX, (whole, dd, mm, yy) => {
      const key = normKey(dd, mm, yy);
      if (userDates.has(key)) return whole; // пользователь назвал дату явно
      if (forbidden.has(key)) {
        unresolved.push(`${label}: дата встречи/договора (${whole}) использована как срок — заменена на «подлежит уточнению»`);
        return 'подлежит уточнению';
      }
      if (sourceDates.has(key)) return whole;
      unresolved.push(`${label}: дата ${whole} отсутствует в расшифровке/ответах — заменена на «подлежит уточнению»`);
      return 'подлежит уточнению';
    });

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
    if (/подлежит уточнению/i.test(r.decision)) warnings.push(`Срок не подтверждён по вопросу «${r.question}» — уточните дату`);
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
