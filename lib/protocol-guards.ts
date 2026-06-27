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

/** Есть ли дата в исходнике (расшифровка + ответы пользователя) в любой из форм 7.2.2026 / 07.02.2026. */
function dateInSource(dd: string, mm: string, yy: string, source: string): boolean {
  const forms = new Set<string>([
    `${dd}.${mm}.${yy}`,
    `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yy}`,
    `${Number(dd)}.${Number(mm)}.${yy}`,
  ]);
  for (const f of forms) if (source.includes(f)) return true;
  return false;
}

export interface DateProvenanceResult { protocol: Protocol; unresolved: string[]; }

/**
 * Любая дата в «Решили»/«Резюме», которой НЕТ в расшифровке или ответах пользователя,
 * считается выдуманной → заменяется на «подлежит уточнению». Возвращает список таких мест.
 */
export function enforceDateProvenance(p: Protocol, sourceText: string): DateProvenanceResult {
  const src = sourceText || '';
  const unresolved: string[] = [];
  const fix = (text: string, label: string): string =>
    (text || '').replace(FULL_DATE_RX, (whole, dd, mm, yy) => {
      if (dateInSource(dd, mm, yy, src)) return whole;
      unresolved.push(`${label}: дата ${whole} отсутствует в расшифровке/ответах — заменена на «подлежит уточнению»`);
      return 'подлежит уточнению';
    });

  const topics = p.meetingContent.topics.map((t) => ({ ...t, decided: fix(t.decided, t.title || 'Решение') }));
  const summary = p.meetingContent.summary.map((r) => ({ ...r, decision: fix(r.decision, r.question || 'Резюме') }));
  return { protocol: { ...p, meetingContent: { topics, summary } }, unresolved };
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
