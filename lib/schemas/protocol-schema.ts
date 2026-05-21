import { z } from 'zod';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';

export const ParticipantSchema = z.object({
  fullName: z.string().describe('ФИО'),
  position: z.string().describe('Должность'),
});

export const MeetingTopicSchema = z.object({
  title: z.string().describe('Название/номер вопроса повестки'),
  listened: z.string().describe('Слушали: ФИО участников, принимавших участие в обсуждении'),
  discussed: z.string().describe('Обсудили: что обсуждалось, с указанием конкретных ФИО'),
  decided: z.string().describe('Решили: принятые решения, срок, ответственные (ФИО, Заказчик/Исполнитель)'),
});

export const SummaryRowSchema = z.object({
  question: z.string().describe('Краткое описание обсуждаемого вопроса'),
  decision: z.string().describe('Принятое решение с ответственными и сроками'),
});

export const ProtocolSchema = z.object({
  // Шапка документа
  protocolNumber: z.string().describe('Номер протокола (например: №7)'),
  meetingDate: z.string().describe('Дата встречи в формате ДД.ММ.ГГГГ'),
  protocolTitle: z.string().describe('Название протокола (краткая повестка)'),
  contractNumber: z.string().optional().describe('Номер договора'),
  contractDate: z.string().optional().describe('Дата договора в формате ДД.ММ.ГГГГ'),
  contractSubject: z.string().optional().describe('Тема/предмет договора'),

  // 2. Повестка
  agenda: z.object({
    items: z.array(z.string()).describe('Пункты повестки нумерованным списком'),
  }),

  // 3. Участники
  participants: z.object({
    customer: z.object({
      organizationName: z.string().describe('Название организации заказчика'),
      people: z.array(ParticipantSchema),
    }),
    executor: z.object({
      organizationName: z.string().describe('Название организации исполнителя'),
      people: z.array(ParticipantSchema),
    }),
  }),

  // 4. Содержание встречи
  meetingContent: z.object({
    topics: z.array(MeetingTopicSchema),
    summary: z.array(SummaryRowSchema).describe('Резюме встречи — таблица обсуждаемых вопросов и принятых решений'),
  }),

  // 5. Согласовано
  approval: z.object({
    customer: z.object({
      organization: z.string().describe('Название организации заказчика'),
      signatories: z.array(z.string()).describe('ФИО подписантов со стороны заказчика'),
    }),
    executor: z.object({
      organization: z.string().describe('Название организации исполнителя'),
      signatories: z.array(z.string()).describe('ФИО подписантов со стороны исполнителя'),
    }),
  }),
});

export type Protocol = z.infer<typeof ProtocolSchema>;

const toStr = (value: unknown) => (value == null ? '' : String(value));
const toArr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const isBlankStr = (v: unknown) => toStr(v).trim().length === 0;

/** Убирает ```json … ``` вокруг ответа модели (Ollama часто так отдаёт structured output). */
export function stripMarkdownCodeFence(raw: string): string {
  let s = raw.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/im);
  if (fenced) return fenced[1].trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
  return s;
}

/** JSON.parse с попыткой вырезать внешний мусор до первого `{` и после последнего `}`. */
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

/** Текст сырого ответа из цепочки AI_NoObjectGeneratedError / AI_JSONParseError. */
export function extractNoObjectGeneratedText(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur && typeof cur === 'object'; i++) {
    const t = (cur as Record<string, unknown>).text;
    if (typeof t === 'string' && t.trim().length > 0) return t;
    cur = (cur as Record<string, unknown>).cause;
  }
  return null;
}

/** Приводит типичные «креативные» формы JSON от LLM к полям новой схемы. */
function preprocessLlmProtocolShape(input: unknown): Record<string, unknown> {
  let root: unknown = input;
  if (typeof root === 'string') root = parseLooseJsonObject(root);
  if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
  let p = root as Record<string, unknown>;
  if (p.protocol && typeof p.protocol === 'object' && !Array.isArray(p.protocol)) {
    p = p.protocol as Record<string, unknown>;
  }

  const out: Record<string, unknown> = { ...p };

  // Совместимость: старый protocolNumber/meetingDate
  if (out.protocolNumber === undefined && p.number !== undefined) out.protocolNumber = p.number;
  if (out.meetingDate === undefined && p.date !== undefined) out.meetingDate = p.date;

  // protocolTitle из старого agenda.title или названия
  if (!out.protocolTitle && p.agenda && typeof p.agenda === 'object' && !Array.isArray(p.agenda)) {
    const ag = p.agenda as Record<string, unknown>;
    if (ag.title) out.protocolTitle = ag.title;
  }

  // agenda: нормализовать items
  if (typeof p.agenda === 'string') {
    out.agenda = { items: [p.agenda] };
  } else if (p.agenda && typeof p.agenda === 'object' && !Array.isArray(p.agenda)) {
    const ag = p.agenda as Record<string, unknown>;
    const items = toArr<string>(ag.items ?? ag.пункты).map(toStr);
    out.agenda = { items };
  }

  // participants: совместимость client→customer
  const po = p.participants as Record<string, unknown> | undefined;
  if (po && !po.customer && Array.isArray((po as Record<string, unknown>).client)) {
    const client = (po as Record<string, unknown>).client as unknown[];
    const executorRaw = (po as Record<string, unknown>).executor;
    const executor = Array.isArray(executorRaw) ? executorRaw : [];
    const custOrg =
      toStr((po as Record<string, unknown>).clientOrganization) || 'Заказчик';
    const execOrg =
      toStr((po as Record<string, unknown>).executorOrganization) || 'Исполнитель';
    out.participants = {
      customer: { organizationName: custOrg, people: client },
      executor: { organizationName: execOrg, people: executor },
    };
  }

  // meetingContent: совместимость старой структуры topics (content → discussed)
  const mc = p.meetingContent as Record<string, unknown> | undefined;
  if (mc && typeof mc === 'object' && !Array.isArray(mc)) {
    const topics = toArr(mc.topics).map((t: unknown) => {
      const row = t && typeof t === 'object' ? (t as Record<string, unknown>) : {};
      return {
        title: toStr(row.title ?? row.тема),
        listened: toStr(row.listened ?? row.слушали ?? ''),
        discussed: toStr(row.discussed ?? row.обсудили ?? row.content ?? row.суть ?? ''),
        decided: toStr(row.decided ?? row.решили ?? row.decision ?? ''),
      };
    });
    const summary = toArr(mc.summary).map((s: unknown) => {
      const row = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      return {
        question: toStr(row.question ?? row.вопрос ?? ''),
        decision: toStr(row.decision ?? row.решение ?? ''),
      };
    });
    out.meetingContent = { topics, summary };
  }

  // approval: совместимость старого executorSignature/customerSignature
  if (!out.approval && p.approval && typeof p.approval === 'object') {
    const appr = p.approval as Record<string, unknown>;
    // Старый формат: approval.executorSignature + approval.customerSignature
    const execSig = appr.executorSignature as Record<string, unknown> | undefined;
    const custSig = appr.customerSignature as Record<string, unknown> | undefined;
    if (execSig || custSig) {
      out.approval = {
        executor: {
          organization: toStr(execSig?.organization ?? 'Исполнитель'),
          signatories: execSig?.representative ? [toStr(execSig.representative)] : [],
        },
        customer: {
          organization: toStr(custSig?.organization ?? 'Заказчик'),
          signatories: custSig?.representative ? [toStr(custSig.representative)] : [],
        },
      };
    }
  }

  // approval: новый формат с signatories как массивы
  if (out.approval && typeof out.approval === 'object') {
    const appr = out.approval as Record<string, unknown>;
    // Нормализовать customer/executor
    for (const side of ['customer', 'executor'] as const) {
      const s = appr[side] as Record<string, unknown> | undefined;
      if (s && typeof s === 'object') {
        // signatories может быть строкой
        if (typeof s.signatories === 'string') {
          s.signatories = s.signatories.trim() ? [s.signatories] : [];
        } else if (!Array.isArray(s.signatories)) {
          s.signatories = [];
        }
      }
    }
  }

  // Заполнить approval из participants если пустое
  if (out.approval && typeof out.approval === 'object' && out.participants && typeof out.participants === 'object') {
    const appr = out.approval as Record<string, unknown>;
    const par = out.participants as Record<string, unknown>;
    const pickFirstNamed = (rows: unknown[]) => {
      for (const row of rows) {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        const name = toStr(r.fullName ?? r.name ?? r.фамилия_имя);
        if (name.trim()) return name;
      }
      return '';
    };
    const fillSide = (approvalKey: string, participantsKey: string) => {
      const side = appr[approvalKey] as Record<string, unknown> | undefined;
      if (!side) return;
      if (Array.isArray(side.signatories) && side.signatories.length > 0) return;
      const grp = par[participantsKey] as Record<string, unknown> | undefined;
      if (!grp || typeof grp !== 'object' || Array.isArray(grp)) return;
      const people = Array.isArray(grp.people) ? (grp.people as unknown[]) : [];
      const firstName = pickFirstNamed(people);
      if (firstName) side.signatories = [firstName];
      if (isBlankStr(side.organization) && !isBlankStr(grp.organizationName)) {
        side.organization = toStr(grp.organizationName);
      }
    };
    fillSide('executor', 'executor');
    fillSide('customer', 'customer');
  }

  return out;
}

/** Приводит произвольный черновик к форме Protocol перед Zod-проверкой. */
export function coerceProtocolPartial(partial: unknown): Protocol {
  const pre = preprocessLlmProtocolShape(partial);
  const p = pre && typeof pre === 'object' && !Array.isArray(pre) ? pre : {};

  const toPeople = (value: unknown) =>
    toArr(value)
      .map((row: unknown) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          fullName: toStr(r.fullName ?? r.name ?? r.фамилия_имя),
          position: toStr(r.position ?? r.role ?? r.должность),
        };
      })
      .filter((person) => isValidParticipantRow(person.fullName, person.position));

  const agendaRaw = p.agenda as Record<string, unknown> | undefined;
  const meetingContentRaw =
    p.meetingContent && typeof p.meetingContent === 'object' && !Array.isArray(p.meetingContent)
      ? (p.meetingContent as Record<string, unknown>)
      : {};
  const approvalRaw =
    p.approval && typeof p.approval === 'object' && !Array.isArray(p.approval)
      ? (p.approval as Record<string, unknown>)
      : {};
  const custApproval =
    approvalRaw.customer && typeof approvalRaw.customer === 'object'
      ? (approvalRaw.customer as Record<string, unknown>)
      : {};
  const execApproval =
    approvalRaw.executor && typeof approvalRaw.executor === 'object'
      ? (approvalRaw.executor as Record<string, unknown>)
      : {};

  return {
    protocolNumber: toStr(p.protocolNumber),
    meetingDate: toStr(p.meetingDate),
    protocolTitle: toStr(p.protocolTitle),
    contractNumber: p.contractNumber !== undefined ? toStr(p.contractNumber) : undefined,
    contractDate: p.contractDate !== undefined ? toStr(p.contractDate) : undefined,
    contractSubject: p.contractSubject !== undefined ? toStr(p.contractSubject) : undefined,
    agenda: {
      items: toArr<string>(agendaRaw?.items ?? agendaRaw?.пункты).map(toStr),
    },
    participants: {
      customer: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
      executor: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
    },
    meetingContent: {
      topics: toArr(meetingContentRaw.topics).map((topic: unknown) => {
        const t = topic && typeof topic === 'object' ? (topic as Record<string, unknown>) : {};
        return {
          title: toStr(t.title ?? t.тема),
          listened: toStr(t.listened ?? t.слушали ?? ''),
          discussed: toStr(t.discussed ?? t.обсудили ?? t.content ?? ''),
          decided: toStr(t.decided ?? t.решили ?? ''),
        };
      }),
      summary: toArr(meetingContentRaw.summary).map((row: unknown) => {
        const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          question: toStr(r.question ?? r.вопрос ?? ''),
          decision: toStr(r.decision ?? r.решение ?? ''),
        };
      }),
    },
    approval: {
      customer: {
        organization: toStr(custApproval.organization ?? custApproval.организация ?? 'Заказчик'),
        signatories: toArr<string>(custApproval.signatories ?? custApproval.подписанты).map(toStr).filter(Boolean),
      },
      executor: {
        organization: toStr(execApproval.organization ?? execApproval.организация ?? 'Исполнитель'),
        signatories: toArr<string>(execApproval.signatories ?? execApproval.подписанты).map(toStr).filter(Boolean),
      },
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
