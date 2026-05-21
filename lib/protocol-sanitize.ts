import type { MeetingQuestion, Protocol, ResumeRow } from '@/lib/schemas/protocol-schema';
import { cleanProtocolText } from '@/lib/protocol-markdown-format';

const PARTICIPANT_NAME_RX =
  /([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)\s*\((Заказчик|Исполнитель)\)/g;

/** Из блока «Слушали» — только ФИО (Заказчик/Исполнитель), без описаний. */
export function extractListenedParticipantNames(text: string): string {
  const raw = cleanProtocolText(text);
  if (!raw) return '';
  const names = new Set<string>();
  for (const m of raw.matchAll(PARTICIPANT_NAME_RX)) {
    names.add(`${m[1].trim()} (${m[2]})`);
  }
  if (names.size > 0) return [...names].join(', ');
  const dash = raw.match(/^([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)\s*[—–-]/);
  if (dash) return dash[1].trim();
  return raw.length > 120 ? raw.slice(0, 120).trim() : raw;
}

function cleanField(value: string): string {
  return cleanProtocolText(value);
}

function cleanMeetingQuestion(q: MeetingQuestion): MeetingQuestion {
  return {
    question: cleanField(q.question),
    listened: extractListenedParticipantNames(q.listened),
    discussed: cleanField(q.discussed),
    decided: cleanField(q.decided),
  };
}

function parseResponsibleAndDeadline(decided: string): { decision: string; responsible?: string; deadline?: string } {
  let decision = decided;
  let responsible: string | undefined;
  let deadline: string | undefined;

  const respM = decision.match(/(?:^|\n)\s*Ответственн(?:ый|ые):\s*([^\n]+)/i);
  if (respM) {
    responsible = cleanField(respM[1]);
    decision = decision.replace(respM[0], '').trim();
  }

  const deadlineM = decision.match(/(?:^|\n)\s*Срок:\s*([^\n.]+)/i);
  if (deadlineM) {
    deadline = cleanField(deadlineM[1]);
    decision = decision.replace(deadlineM[0], '').trim();
  }

  return { decision: cleanField(decision), responsible, deadline };
}

export function buildResumeFromMeetingQuestions(questions: MeetingQuestion[]): ResumeRow[] {
  return questions
    .filter((q) => q.question.trim() || q.decided.trim())
    .map((q) => {
      const parsed = parseResponsibleAndDeadline(q.decided);
      return {
        discussedQuestion: q.question.trim() || '—',
        decision: parsed.decision || q.decided.trim() || '—',
        deadline: parsed.deadline,
        responsible: parsed.responsible,
      };
    });
}

/** Согласованные в чате данные имеют приоритет над выводом LLM из расшифровки. */
export function mergeProtocolWithChatDraft(model: Protocol, chatDraft: Partial<Protocol>): Protocol {
  if (!chatDraft || Object.keys(chatDraft).length === 0) return model;

  const merged: Protocol = { ...model, participants: { ...model.participants }, approval: { ...model.approval } };

  const assign = <K extends keyof Protocol>(key: K, value: Protocol[K] | undefined) => {
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === 'string' && !value.trim()) return;
    merged[key] = value;
  };

  assign('protocolNumber', chatDraft.protocolNumber);
  assign('protocolDate', chatDraft.protocolDate);
  assign('protocolTitle', chatDraft.protocolTitle);
  assign('contractNumber', chatDraft.contractNumber);
  assign('contractDate', chatDraft.contractDate);
  assign('contractTopic', chatDraft.contractTopic);
  assign('assemblyDate', chatDraft.assemblyDate);
  assign('agendaItems', chatDraft.agendaItems);
  assign('meetingQuestions', chatDraft.meetingQuestions);
  assign('resume', chatDraft.resume);

  if (chatDraft.participants) {
    merged.participants = chatDraft.participants;
  }
  if (chatDraft.approval) {
    merged.approval = chatDraft.approval;
  }

  return merged;
}

export function finalizeProtocol(protocol: Protocol): Protocol {
  const agendaItems = protocol.agendaItems.map(cleanField).filter(Boolean);
  let meetingQuestions = protocol.meetingQuestions.map(cleanMeetingQuestion).filter((q) => q.question || q.decided);

  if (agendaItems.length > 0) {
    if (meetingQuestions.length > agendaItems.length) {
      meetingQuestions = meetingQuestions.slice(0, agendaItems.length);
    }
    meetingQuestions = meetingQuestions.map((q, i) => ({
      ...q,
      question: q.question || agendaItems[i] || '',
    }));
    while (meetingQuestions.length < agendaItems.length) {
      meetingQuestions.push({
        question: agendaItems[meetingQuestions.length] ?? '',
        listened: '',
        discussed: '',
        decided: '',
      });
    }
  }

  meetingQuestions = meetingQuestions.filter(
    (q) => q.listened.trim() || q.discussed.trim() || q.decided.trim() || agendaItems.includes(q.question),
  );

  let resume: ResumeRow[] = protocol.resume.map((r) => ({
    discussedQuestion: cleanField(r.discussedQuestion),
    decision: cleanField(r.decision),
    deadline: r.deadline ? cleanField(r.deadline) : undefined,
    responsible: r.responsible ? cleanField(r.responsible) : undefined,
  }));

  if (resume.length === 0 && meetingQuestions.length > 0) {
    resume = buildResumeFromMeetingQuestions(meetingQuestions);
  }

  resume = resume.map((row) => {
    if (row.responsible || row.deadline) return row;
    const parsed = parseResponsibleAndDeadline(row.decision);
    return {
      discussedQuestion: row.discussedQuestion,
      decision: parsed.decision || row.decision,
      deadline: parsed.deadline,
      responsible: parsed.responsible,
    };
  });

  const customerPeople = protocol.participants.customer.people
    .map((p) => ({ fullName: cleanField(p.fullName), position: cleanField(p.position) }))
    .filter((p) => p.fullName || p.position);

  const executorPeople = protocol.participants.executor.people
    .map((p) => ({ fullName: cleanField(p.fullName), position: cleanField(p.position) }))
    .filter((p) => p.fullName || p.position);

  const customerSigs = protocol.approval.customer.signatories.map(cleanField).filter(Boolean);
  const executorSigs = protocol.approval.executor.signatories.map(cleanField).filter(Boolean);

  return {
    protocolNumber: cleanField(protocol.protocolNumber),
    protocolDate: cleanField(protocol.protocolDate),
    protocolTitle: cleanField(protocol.protocolTitle),
    contractNumber: cleanField(protocol.contractNumber),
    contractDate: cleanField(protocol.contractDate),
    contractTopic: cleanField(protocol.contractTopic),
    assemblyDate: cleanField(protocol.assemblyDate) || cleanField(protocol.protocolDate),
    agendaItems,
    participants: {
      customer: {
        organizationName: cleanField(protocol.participants.customer.organizationName) || 'Заказчик',
        people: customerPeople,
      },
      executor: {
        organizationName:
          cleanField(protocol.participants.executor.organizationName) || 'Исполнитель',
        people: executorPeople,
      },
    },
    meetingQuestions,
    resume,
    approval: {
      customer: {
        organizationName: cleanField(protocol.approval.customer.organizationName) || 'Заказчик',
        signatories: customerSigs,
      },
      executor: {
        organizationName: cleanField(protocol.approval.executor.organizationName) || 'Исполнитель',
        signatories: executorSigs.length
          ? executorSigs
          : executorPeople.map((p) => p.fullName).filter(Boolean),
      },
    },
  };
}
