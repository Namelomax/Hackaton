import { z } from 'zod';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';

export const ParticipantSchema = z.object({
  fullName: z.string().describe('ФИО'),
  position: z.string().describe('Должность'),
});

/** Пункт повестки в разделе 4: Слушали / Обсудили / Решили. */
export const MeetingQuestionSchema = z.object({
  question: z.string().describe('Формулировка вопроса повестки'),
  listened: z.string().describe('Слушали: только ФИО участников (Заказчик/Исполнитель), через запятую — без описаний'),
  discussed: z.string().describe('Обсудили: с ФИО и стороной (Заказчик/Исполнитель)'),
  decided: z.string().describe('Решили: решение, срок, ответственные'),
});

/** Строка таблицы «Резюме». */
export const ResumeRowSchema = z.object({
  discussedQuestion: z.string().describe('Обсуждаемый вопрос'),
  decision: z.string().describe('Принятое решение'),
  deadline: z.string().optional().describe('Срок исполнения'),
  responsible: z.string().optional().describe('Ответственный (ФИО, Заказчик/Исполнитель)'),
});

export const ApprovalSideSchema = z.object({
  organizationName: z.string().describe('ООО «…» или наименование организации'),
  signatories: z.array(z.string()).describe('Фамилия И.О. для подписи'),
});

export const ProtocolSchema = z.object({
  protocolNumber: z.string().describe('Номер протокола (например: 1 или №1)'),
  protocolDate: z.string().describe('Дата в шапке ПРОТОКОЛ … ОТ … (ДД.ММ.ГГГГ)'),
  protocolTitle: z.string().describe('Название протокола — краткая повестка'),
  contractNumber: z.string().describe('Номер договора'),
  contractDate: z.string().describe('Дата договора'),
  contractTopic: z.string().describe('Тема договора'),

  assemblyDate: z.string().describe('1. Дата собрания (ДД.ММ.ГГГГ)'),

  agendaItems: z.array(z.string()).describe('2. Повестка — пункты 1), 2), …'),

  participants: z.object({
    customer: z.object({
      organizationName: z.string().describe('Организация заказчика'),
      people: z.array(ParticipantSchema),
    }),
    executor: z.object({
      organizationName: z.string().describe('Организация исполнителя'),
      people: z.array(ParticipantSchema),
    }),
  }),

  meetingQuestions: z.array(MeetingQuestionSchema).describe('4. Содержание встречи по пунктам повестки'),

  resume: z.array(ResumeRowSchema).describe('Таблица «Резюме» в конце раздела 4'),

  approval: z.object({
    customer: ApprovalSideSchema,
    executor: ApprovalSideSchema,
  }),
});

export type Protocol = z.infer<typeof ProtocolSchema>;
export type MeetingQuestion = z.infer<typeof MeetingQuestionSchema>;
export type ResumeRow = z.infer<typeof ResumeRowSchema>;

const toStr = (value: unknown) => (value == null ? '' : String(value));
const toArr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const isBlankStr = (v: unknown) => toStr(v).trim().length === 0;

function meetingQuestionEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return (
    isBlankStr(r.question ?? r.вопрос) &&
    isBlankStr(r.listened ?? r.слушали) &&
    isBlankStr(r.discussed ?? r.обсудили) &&
    isBlankStr(r.decided ?? r.решили)
  );
}

function resumeRowEmpty(row: unknown): boolean {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return isBlankStr(r.discussedQuestion ?? r.question) && isBlankStr(r.decision ?? r.решение);
}

function isVacuousArray(arr: unknown, rowIsEmpty: (row: unknown) => boolean): boolean {
  if (!Array.isArray(arr) || arr.length === 0) return true;
  return arr.every(rowIsEmpty);
}

/** Убирает ```json … ``` вокруг ответа модели. */
export function stripMarkdownCodeFence(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/im);
  if (fenced) return fenced[1].trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  return s;
}

export function parseLooseJsonObject(raw: string): unknown | null {
  const s = stripMarkdownCodeFence(raw);
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function extractNoObjectGeneratedText(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur && typeof cur === 'object'; i++) {
    const t = (cur as Record<string, unknown>).text;
    if (typeof t === 'string' && t.trim().length > 0) return t;
    cur = (cur as Record<string, unknown>).cause;
  }
  return null;
}

function mapPerson(row: unknown) {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    fullName: toStr(r.fullName ?? r.name ?? r.фамилия_имя),
    position: toStr(r.position ?? r.role ?? r.должность),
  };
}

function mapMeetingQuestion(row: unknown): MeetingQuestion {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    question: toStr(r.question ?? r.вопрос ?? r.title ?? r.тема),
    listened: toStr(r.listened ?? r.слушали),
    discussed: toStr(r.discussed ?? r.обсудили ?? r.content ?? r.суть),
    decided: toStr(r.decided ?? r.решили ?? r.decision ?? r.решение),
  };
}

function mapResumeRow(row: unknown): ResumeRow {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    discussedQuestion: toStr(r.discussedQuestion ?? r.question ?? r.вопрос ?? r.discussed),
    decision: toStr(r.decision ?? r.решение),
    deadline: toStr(r.deadline ?? r.срок ?? r.dueDate) || undefined,
    responsible: toStr(r.responsible ?? r.ответственный) || undefined,
  };
}

function mapApprovalSide(raw: unknown, fallbackOrg: string): z.infer<typeof ApprovalSideSchema> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const sigs = toArr(r.signatories ?? r.signatures ?? r.подписи);
    const fromSigs = sigs
      .map((s) => {
        if (typeof s === 'string') return s.trim();
        const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        return toStr(o.name ?? o.fullName ?? o.фамилия_имя).trim();
      })
      .filter(Boolean);
    const rep = toStr(r.representative ?? r.представитель);
    const signatories = fromSigs.length ? fromSigs : rep ? [rep] : [];
    return {
      organizationName: toStr(r.organizationName ?? r.organization ?? r.организация) || fallbackOrg,
      signatories,
    };
  }
  return { organizationName: fallbackOrg, signatories: [] };
}

/** Маппинг новой нумерации 1_…5_ и шапки из русских ключей. */
function applyRussianNumberedProtocolSections(p: Record<string, unknown>): void {
  const header = p['шапка'] ?? p.header;
  if (header && typeof header === 'object' && !Array.isArray(header)) {
    const h = header as Record<string, unknown>;
    if (isBlankStr(p.protocolNumber)) p.protocolNumber = h.номер ?? h.number;
    if (isBlankStr(p.protocolDate)) p.protocolDate = h.дата ?? h.date;
    if (isBlankStr(p.protocolTitle)) p.protocolTitle = h.название ?? h.title;
    if (isBlankStr(p.contractNumber)) p.contractNumber = h.номер_договора ?? h.contractNumber;
    if (isBlankStr(p.contractDate)) p.contractDate = h.дата_договора ?? h.contractDate;
    if (isBlankStr(p.contractTopic)) p.contractTopic = h.тема_договора ?? h.contractTopic;
  }

  const sec1 = p['1_дата_собрания'] ?? p['1_номер_и_дата'];
  if (sec1 && typeof sec1 === 'object' && !Array.isArray(sec1)) {
    const n = sec1 as Record<string, unknown>;
    if (isBlankStr(p.assemblyDate)) p.assemblyDate = n.дата ?? n.date ?? n.дата_собрания;
    if (isBlankStr(p.protocolNumber)) p.protocolNumber = n.номер ?? n.number;
    if (isBlankStr(p.protocolDate)) p.protocolDate = n.дата_протокола ?? n.protocolDate;
  } else if (typeof sec1 === 'string' && isBlankStr(p.assemblyDate)) {
    p.assemblyDate = sec1;
  }

  const sec2 = p['2_повестка'];
  if (sec2 != null && isBlankStr(p.agendaItems)) {
    if (Array.isArray(sec2)) p.agendaItems = sec2.map(toStr);
    else if (typeof sec2 === 'object') {
      const ag = sec2 as Record<string, unknown>;
      const items = toArr<string>(ag.пункты ?? ag.items).map(toStr);
      if (items.length) p.agendaItems = items;
      else if (ag.тема ?? ag.title) p.agendaItems = [toStr(ag.тема ?? ag.title)];
    } else if (typeof sec2 === 'string') {
      p.agendaItems = [sec2];
    }
  }

  const sec3 = p['3_участники'];
  if (sec3 && typeof sec3 === 'object' && !Array.isArray(sec3) && p.participants == null) {
    const u = sec3 as Record<string, unknown>;
    const cust = u.заказчик ?? u.customer;
    const exec = u.исполнитель ?? u.executor;
    if (cust && typeof cust === 'object' && exec && typeof exec === 'object') {
      const cu = cust as Record<string, unknown>;
      const eu = exec as Record<string, unknown>;
      p.participants = {
        customer: {
          organizationName: toStr(cu.организация ?? cu.organizationName) || 'Заказчик',
          people: toArr(cu.участники ?? cu.people).map(mapPerson),
        },
        executor: {
          organizationName: toStr(eu.организация ?? eu.organizationName) || 'Исполнитель',
          people: toArr(eu.участники ?? eu.people).map(mapPerson),
        },
      };
    }
  }

  const sec4 = p['4_содержание'];
  if (sec4 != null && isVacuousArray(p.meetingQuestions, meetingQuestionEmpty)) {
    if (Array.isArray(sec4)) {
      p.meetingQuestions = sec4.map(mapMeetingQuestion);
    } else if (typeof sec4 === 'object') {
      const s4 = sec4 as Record<string, unknown>;
      const qs = s4.вопросы ?? s4.questions ?? s4.topics;
      if (Array.isArray(qs)) p.meetingQuestions = qs.map(mapMeetingQuestion);
      const res = s4.резюме ?? s4.resume;
      if (Array.isArray(res)) p.resume = res.map(mapResumeRow);
    }
  }

  const sec5 = p['5_согласовано'] ?? p['10_согласование'];
  if (sec5 && typeof sec5 === 'object' && !Array.isArray(sec5) && p.approval == null) {
    const s5 = sec5 as Record<string, unknown>;
    p.approval = {
      customer: mapApprovalSide(s5.заказчик ?? s5.customer ?? s5.customerSignature, 'Заказчик'),
      executor: mapApprovalSide(s5.исполнитель ?? s5.executor ?? s5.executorSignature, 'Исполнитель'),
    };
  }
}

/** Старый формат (10 разделов) → новая схема. */
function migrateLegacyProtocolFields(p: Record<string, unknown>): void {
  if (isBlankStr(p.protocolDate) && p.meetingDate) p.protocolDate = toStr(p.meetingDate);
  if (isBlankStr(p.assemblyDate) && p.meetingDate) p.assemblyDate = toStr(p.meetingDate);

  const agenda = p.agenda as Record<string, unknown> | undefined;
  if (agenda && isVacuousArray(p.agendaItems, (x) => isBlankStr(x))) {
    const items = toArr<string>(agenda.items).map(toStr).filter(Boolean);
    if (items.length) p.agendaItems = items;
    if (isBlankStr(p.protocolTitle) && agenda.title) p.protocolTitle = toStr(agenda.title);
  }
  if (typeof p.agenda === 'string' && isVacuousArray(p.agendaItems, (x) => isBlankStr(x))) {
    p.agendaItems = [toStr(p.agenda)];
  }

  const mc = p.meetingContent as Record<string, unknown> | undefined;
  if (mc && isVacuousArray(p.meetingQuestions, meetingQuestionEmpty)) {
    const topics = toArr(mc.topics);
    if (topics.length) {
      p.meetingQuestions = topics.map((t) => {
        const row = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
        return mapMeetingQuestion(row);
      });
    }
  }

  if (isVacuousArray(p.resume, resumeRowEmpty) && Array.isArray(p.decisions)) {
    p.resume = (p.decisions as unknown[]).map((d) => {
      const r = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
      return {
        discussedQuestion: toStr(r.question ?? r.discussedQuestion),
        decision: toStr(r.decision ?? r.решение),
        responsible: toStr(r.responsible ?? r.ответственный) || undefined,
      };
    });
  }

  const appr = p.approval as Record<string, unknown> | undefined;
  if (appr && !appr.customer && (appr.customerSignature || appr.executorSignature)) {
    p.approval = {
      customer: mapApprovalSide(appr.customerSignature, 'Заказчик'),
      executor: mapApprovalSide(appr.executorSignature, 'Исполнитель'),
    };
  }
}

function preprocessLlmProtocolShape(input: unknown): Record<string, unknown> {
  let root: unknown = input;
  if (typeof root === 'string') root = parseLooseJsonObject(root);
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  let p = root as Record<string, unknown>;
  if (p.protocol && typeof p.protocol === 'object' && !Array.isArray(p.protocol)) {
    p = p.protocol as Record<string, unknown>;
  }

  applyRussianNumberedProtocolSections(p);
  migrateLegacyProtocolFields(p);

  const out: Record<string, unknown> = { ...p };

  if (isBlankStr(out.protocolNumber) && p.number != null) out.protocolNumber = p.number;
  if (isBlankStr(out.protocolDate) && p.date != null) out.protocolDate = p.date;

  const po = p.participants as Record<string, unknown> | undefined;
  if (po && !po.customer && Array.isArray(po.client)) {
    out.participants = {
      customer: {
        organizationName: toStr(po.clientOrganization) || 'Заказчик',
        people: toArr(po.client).map(mapPerson),
      },
      executor: {
        organizationName: toStr(po.executorOrganization) || 'Исполнитель',
        people: toArr(po.executor).map(mapPerson),
      },
    };
  }

  if (isVacuousArray(out.meetingQuestions, meetingQuestionEmpty) && Array.isArray(p.meetingQuestions)) {
    out.meetingQuestions = (p.meetingQuestions as unknown[]).map(mapMeetingQuestion);
  }

  if (isVacuousArray(out.resume, resumeRowEmpty) && Array.isArray(p.resume)) {
    out.resume = (p.resume as unknown[]).map(mapResumeRow);
  }

  if (out.approval && typeof out.approval === 'object' && out.participants && typeof out.participants === 'object') {
    const appr = out.approval as Record<string, unknown>;
    const par = out.participants as Record<string, unknown>;
    const fillSide = (sideKey: 'customer' | 'executor', grpKey: string) => {
      const side = appr[sideKey] as Record<string, unknown> | undefined;
      const grp = par[grpKey] as Record<string, unknown> | undefined;
      if (!side || !grp || typeof grp !== 'object') return;
      const people = toArr(grp.people);
      const pickFirst = () => {
        for (const row of people) {
          const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
          const name = toStr(r.fullName ?? r.name);
          if (name.trim()) return name;
        }
        return '';
      };
      const sigs = toArr(side.signatories).map(toStr).filter(Boolean);
      if (sigs.length === 0) {
        const rep = pickFirst();
        if (rep) side.signatories = [rep];
      }
      if (isBlankStr(side.organizationName)) {
        side.organizationName = toStr(grp.organizationName) || (sideKey === 'customer' ? 'Заказчик' : 'Исполнитель');
      }
    };
    fillSide('customer', 'customer');
    fillSide('executor', 'executor');
  }

  if (Array.isArray(out.meetingQuestions)) {
    out.meetingQuestions = (out.meetingQuestions as unknown[]).filter((row) => !meetingQuestionEmpty(row));
  }
  if (Array.isArray(out.resume)) {
    out.resume = (out.resume as unknown[]).filter((row) => !resumeRowEmpty(row));
  }

  return out;
}

export function coerceProtocolPartial(partial: unknown): Protocol {
  const pre = preprocessLlmProtocolShape(partial);
  const p = pre && typeof pre === 'object' && !Array.isArray(pre) ? pre : {};

  const toPeople = (value: unknown) =>
    toArr(value)
      .map(mapPerson)
      .filter((row) => isValidParticipantRow(row.fullName, row.position));

  const participantsRaw =
    p.participants && typeof p.participants === 'object' && !Array.isArray(p.participants)
      ? (p.participants as Record<string, unknown>)
      : {};

  const approvalRaw =
    p.approval && typeof p.approval === 'object' && !Array.isArray(p.approval)
      ? (p.approval as Record<string, unknown>)
      : {};

  return {
    protocolNumber: toStr(p.protocolNumber),
    protocolDate: toStr(p.protocolDate),
    protocolTitle: toStr(p.protocolTitle),
    contractNumber: toStr(p.contractNumber),
    contractDate: toStr(p.contractDate),
    contractTopic: toStr(p.contractTopic),
    assemblyDate: toStr(p.assemblyDate),
    agendaItems: toArr<string>(p.agendaItems).map(toStr).filter(Boolean),
    participants: {
      customer: {
        organizationName: toStr(
          (participantsRaw.customer as Record<string, unknown> | undefined)?.organizationName,
        ),
        people: toPeople((participantsRaw.customer as Record<string, unknown> | undefined)?.people),
      },
      executor: {
        organizationName: toStr(
          (participantsRaw.executor as Record<string, unknown> | undefined)?.organizationName,
        ),
        people: toPeople((participantsRaw.executor as Record<string, unknown> | undefined)?.people),
      },
    },
    meetingQuestions: toArr(p.meetingQuestions).map(mapMeetingQuestion),
    resume: toArr(p.resume).map(mapResumeRow),
    approval: {
      customer: mapApprovalSide(approvalRaw.customer ?? approvalRaw.customerSignature, 'Заказчик'),
      executor: mapApprovalSide(approvalRaw.executor ?? approvalRaw.executorSignature, 'Исполнитель'),
    },
  };
}

export function parseProtocolStrict(input: unknown): Protocol {
  return ProtocolSchema.parse(coerceProtocolPartial(input));
}

export function safeParseProtocol(input: unknown) {
  return ProtocolSchema.safeParse(coerceProtocolPartial(input));
}

export const TranscriptAnalysisSchema = z.object({
  hasContradictions: z.boolean().describe('Обнаружены ли противоречия'),
  contradictions: z.array(z.string()).describe('Список обнаруженных противоречий'),
  hasAmbiguities: z.boolean().describe('Есть ли недосказанности/неясности'),
  ambiguities: z.array(z.string()).describe('Список недосказанностей'),
  missingCriticalInfo: z.array(z.string()).describe('Список критически важной недостающей информации'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Уровень уверенности в полноте данных'),
});

export type TranscriptAnalysis = z.infer<typeof TranscriptAnalysisSchema>;

export const ProtocolInstructionSchema = z.object({
  instruction: z.string().describe('Подробная инструкция по созданию протокола'),
  openQuestions: z.array(z.string()).describe('Список вопросов для уточнения'),
});

export type ProtocolInstruction = z.infer<typeof ProtocolInstructionSchema>;
