import type { Protocol } from '@/lib/schemas/protocol-schema';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';
import { cleanProtocolText, isProtocolBoilerplateLine } from '@/lib/protocol-markdown-format';

type ChatTurn = { role: string; text: string };

const USER_CONFIRM_RX =
  /^(верно|да|ок|окей|ладно|всё\s*верно|все\s*верно|согласен|подтверждаю|к\s+следующему|далее|продолжай|хорошо)([.!?,]|\s|$)/i;

function extractUiMessageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const m = msg as Record<string, unknown>;
  if (Array.isArray(m.parts)) {
    const texts = (m.parts as unknown[])
      .map((p) => {
        const part = p as Record<string, unknown>;
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  if (typeof m.content === 'string') return m.content;
  return '';
}

function stripTimecodes(text: string): string {
  return text
    .replace(/\{\{ТС:\s*[^}]+\}\}/gi, '')
    .replace(/\[ТС:\s*[^\]]+\]/gi, '')
    .replace(/\[TC:\s*[^\]]+\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function uiMessagesToTurns(uiMessages: unknown[]): ChatTurn[] {
  return uiMessages
    .map((msg) => ({
      role: String((msg as Record<string, unknown>)?.role ?? ''),
      text: extractUiMessageText(msg),
    }))
    .filter((t) => t.text.trim().length > 0);
}

/** Тексты ассистента, после которых пользователь ответил «Верно» и т.п. */
export function collectUserConfirmedAssistantBlocks(uiMessages: unknown[]): string[] {
  const turns = uiMessagesToTurns(uiMessages);
  const blocks: string[] = [];
  for (let i = 1; i < turns.length; i++) {
    const user = turns[i];
    if (user.role !== 'user' || !USER_CONFIRM_RX.test(user.text.trim())) continue;
    const prev = turns[i - 1];
    if (prev.role === 'assistant' && prev.text.trim().length > 40) {
      blocks.push(prev.text);
    }
  }
  return blocks;
}

function parseDashListItems(text: string): Array<{ left: string; right: string }> {
  const items: Array<{ left: string; right: string }> = [];
  for (const rawLine of text.split('\n')) {
    const line = stripTimecodes(rawLine.trim());
    if (!line || line.startsWith('|') || line.startsWith('---')) continue;
    const m = line.match(/^(.+?)\s*[–—-]\s*(.+)$/);
    if (!m) continue;
    const left = m[1].trim();
    const right = m[2].trim();
    if (
      left.length > 0 &&
      left.length < 120 &&
      right.length > 0 &&
      !isProtocolBoilerplateLine(left) &&
      !isProtocolBoilerplateLine(right)
    ) {
      items.push({ left, right });
    }
  }
  return items;
}

function parseTermsFromBlocks(blocks: string[]): Protocol['termsAndDefinitions'] {
  let best: Protocol['termsAndDefinitions'] = [];
  for (const block of blocks) {
    if (!/термин|определен|ФЗ|1С|BPMN|НОМЕНКЛАТУРА/i.test(block)) continue;
    const items = parseDashListItems(block)
      .filter((x) => !/^верно\??$/i.test(x.left))
      .map((x) => ({ term: x.left, definition: x.right }));
    if (items.length > best.length) best = items;
  }
  return best;
}

function parseAbbreviationsFromBlocks(blocks: string[]): Protocol['abbreviations'] {
  let best: Protocol['abbreviations'] = [];
  for (const block of blocks) {
    if (!/сокращен|обозначен|ВКС|PDF|DOCX/i.test(block)) continue;
    const items = parseDashListItems(block)
      .filter((x) => x.left.length <= 20)
      .map((x) => ({ abbreviation: x.left, fullForm: x.right }));
    if (items.length > best.length) best = items;
  }
  return best;
}

function parseMeetingTopicsFromBlocks(blocks: string[]): Protocol['meetingContent']['topics'] {
  let best: Protocol['meetingContent']['topics'] = [];
  for (const block of blocks) {
    if (!/содержание встречи|ключевые моменты|Проблемы подготовки|раздел\s*6/i.test(block)) continue;
    const topics: Protocol['meetingContent']['topics'] = [];
    for (const rawLine of block.split('\n')) {
      const line = stripTimecodes(rawLine.trim());
      const m = line.match(/^(.{3,120}?):\s+(.+)$/);
      if (!m) continue;
      const title = m[1].trim();
      const content = m[2].trim();
      if (
        /^(верно|вопрос|ответ|решение|статус|раздел|перехожу|отлично|теперь)/i.test(title) ||
        content.length < 15
      ) {
        continue;
      }
      topics.push({ title, content });
    }
    if (topics.length > best.length) best = topics;
  }
  return best;
}

function parseQaFromBlocks(blocks: string[]): Protocol['questionsAndAnswers'] {
  let best: Protocol['questionsAndAnswers'] = [];
  for (const block of blocks) {
    if (!/вопрос|ответ/i.test(block)) continue;
    const qa: Protocol['questionsAndAnswers'] = [];
    const re = /Вопрос:\s*[«"]?([^»"\n]+)[»"]?\s*([\s\S]*?)(?=Вопрос:|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const question = stripTimecodes(m[1].trim());
      const tail = m[2];
      const ansM = tail.match(/Ответ:\s*([\s\S]*?)(?=Вопрос:|$)/i);
      let answer = ansM ? stripTimecodes(ansM[1].trim()) : '';
      answer = answer.replace(/\n\s*\d+[.)]\s+[\s\S]*$/, '').trim();
      answer = cleanProtocolText(answer);
      const qClean = cleanProtocolText(question);
      if (qClean && !isProtocolBoilerplateLine(qClean)) qa.push({ question: qClean, answer });
    }
    if (qa.length > best.length) best = qa;
  }
  return best;
}

function parseDecisionsFromBlocks(blocks: string[]): Protocol['decisions'] {
  let best: Protocol['decisions'] = [];
  for (const block of blocks) {
    if (!/решени/i.test(block)) continue;
    const decisions: Protocol['decisions'] = [];
    const re = /Решение:\s*([\s\S]*?)(?=Решение:|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const tail = m[1];
      const decM = tail.match(/^(.+?)(?:\n|$)/);
      const decision = decM ? stripTimecodes(decM[1].trim()) : '';
      const respM = tail.match(/Ответственный:\s*(.+?)(?:\n|$)/i);
      const responsible = respM ? stripTimecodes(respM[1].trim()) : '';
      if (decision) decisions.push({ decision, responsible });
    }
    if (decisions.length > best.length) best = decisions;
  }
  return best;
}

function parseOpenQuestionsFromBlocks(blocks: string[]): string[] {
  let best: string[] = [];
  for (const block of blocks) {
    if (!/открыт|статус:/i.test(block)) continue;
    const items: string[] = [];
    const re = /Вопрос:\s*([\s\S]*?)(?=Вопрос:|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const tail = m[1].trim();
      const qM = tail.match(/^(.+?)(?:\n|Статус:)/i);
      const question = qM ? stripTimecodes(qM[1].trim()) : stripTimecodes(tail);
      const stM = tail.match(/Статус:\s*(.+?)(?:\n|$)/i);
      const status = stM ? stripTimecodes(stM[1].trim()) : '';
      const line = status ? `${question} Статус: ${status}` : question;
      if (question.length > 10) items.push(line);
    }
    if (items.length > best.length) best = items;
  }
  return best;
}

function parseApprovalFromBlocks(blocks: string[]): Protocol['approval'] | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!/согласован|раздел\s*10|подпис/i.test(block)) continue;
    let customerRep = '';
    let executorRep = '';
    const custM = block.match(
      /(?:со\s+стороны\s+заказчика|заказчик)[^:\n]*:\s*([^\n\[]+)/i,
    );
    if (custM) customerRep = stripTimecodes(custM[1].trim());
    const execM = block.match(
      /(?:со\s+стороны\s+исполнителя|исполнитель)[^:\n]*:\s*([^\n\[]+)/i,
    );
    if (execM) {
      executorRep = stripTimecodes(execM[1].trim());
      const namesInParens = executorRep.match(/\(([^)]+)\)/);
      if (namesInParens) executorRep = namesInParens[1];
    }
    if (customerRep || executorRep) {
      return {
        executorSignature: {
          organization: 'Исполнитель',
          representative: executorRep || 'Не указано в расшифровке',
        },
        customerSignature: {
          organization: 'Группа компаний Форус',
          representative: customerRep || 'Не указано в расшифровке',
        },
      };
    }
  }
  return undefined;
}

function parseParticipantsFromBlocks(blocks: string[]): Protocol['participants'] | undefined {
  let customerPeople: Protocol['participants']['customer']['people'] = [];
  let executorPeople: Protocol['participants']['executor']['people'] = [];
  let custOrg = '';
  let execOrg = '';

  for (const block of blocks) {
    if (!/участник|заказчик|исполнитель|Dream Team|Оптима|КФК/i.test(block)) continue;
    const custSec = block.match(
      /со\s+стороны\s+заказчика[^]*?(?=со\s+стороны\s+исполнителя|$)/i,
    );
    const execSec = block.match(/со\s+стороны\s+исполнителя[^]*/i);
    const parseTable = (sec: string | null, side: 'customer' | 'executor') => {
      if (!sec) return;
      const orgM = sec.match(/\(([^)]+)\)/);
      if (orgM) {
        if (side === 'customer') custOrg = orgM[1];
        else execOrg = orgM[1];
      }
      const rows: Protocol['participants']['customer']['people'] = [];
      for (const line of sec.split('\n')) {
        const cells = line
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean);
        if (cells.length < 2 || /фио|должность/i.test(cells[0])) continue;
        const fullName = stripTimecodes(cells[0]);
        const position = stripTimecodes(cells[1]);
        if (!isValidParticipantRow(fullName, position)) continue;
        rows.push({ fullName, position });
      }
      if (rows.length) {
        if (side === 'customer') customerPeople = rows;
        else executorPeople = rows;
      }
    };
    parseTable(custSec?.[0] ?? null, 'customer');
    parseTable(execSec?.[0] ?? null, 'executor');
  }

  if (customerPeople.length === 0 && executorPeople.length === 0) return undefined;
  return {
    customer: {
      organizationName: custOrg || 'Группа компаний Форус',
      people: customerPeople,
    },
    executor: {
      organizationName: execOrg || 'Исполнитель',
      people: executorPeople,
    },
  };
}

/** Черновик протокола из сообщений ассистента, подтверждённых пользователем. */
export function buildProtocolDraftFromChat(uiMessages: unknown[]): Partial<Protocol> {
  const blocks = collectUserConfirmedAssistantBlocks(uiMessages);
  if (blocks.length === 0) return {};

  const termsAndDefinitions = parseTermsFromBlocks(blocks);
  const abbreviations = parseAbbreviationsFromBlocks(blocks);
  const topics = parseMeetingTopicsFromBlocks(blocks);
  const questionsAndAnswers = parseQaFromBlocks(blocks);
  const decisions = parseDecisionsFromBlocks(blocks);
  const openQuestions = parseOpenQuestionsFromBlocks(blocks);
  const approval = parseApprovalFromBlocks(blocks);
  const participants = parseParticipantsFromBlocks(blocks);

  const draft: Partial<Protocol> = {};
  if (termsAndDefinitions.length) draft.termsAndDefinitions = termsAndDefinitions;
  if (abbreviations.length) draft.abbreviations = abbreviations;
  if (topics.length) draft.meetingContent = { introduction: '', topics };
  if (questionsAndAnswers.length) draft.questionsAndAnswers = questionsAndAnswers;
  if (decisions.length) draft.decisions = decisions;
  if (openQuestions.length) draft.openQuestions = openQuestions;
  if (approval) draft.approval = approval;
  if (participants) draft.participants = participants;

  return draft;
}

function hasTerms(p: Protocol): boolean {
  return p.termsAndDefinitions.some((t) => t.term.trim() && t.definition.trim());
}
function hasAbbr(p: Protocol): boolean {
  return p.abbreviations.some((a) => a.abbreviation.trim() && a.fullForm.trim());
}
function hasTopics(p: Protocol): boolean {
  return p.meetingContent.topics.some((t) => t.title.trim() && t.content.trim());
}
function hasQa(p: Protocol): boolean {
  return p.questionsAndAnswers.some((q) => q.question.trim());
}
function hasDecisions(p: Protocol): boolean {
  return p.decisions.some((d) => d.decision.trim());
}
function hasApproval(p: Protocol): boolean {
  return Boolean(
    p.approval.executorSignature.representative.trim() ||
      p.approval.customerSignature.representative.trim(),
  );
}

/** Подмешивает в итоговый протокол согласованные в чате разделы, если модель вернула пустые поля. */
export function mergeProtocolWithChatDraft(model: Protocol, chatDraft: Partial<Protocol>): Protocol {
  if (!chatDraft || Object.keys(chatDraft).length === 0) return model;

  const merged: Protocol = { ...model };

  if (!hasTerms(merged) && chatDraft.termsAndDefinitions?.length) {
    merged.termsAndDefinitions = chatDraft.termsAndDefinitions;
  }
  if (!hasAbbr(merged) && chatDraft.abbreviations?.length) {
    merged.abbreviations = chatDraft.abbreviations;
  }
  if (!hasTopics(merged) && chatDraft.meetingContent?.topics?.length) {
    merged.meetingContent = {
      ...merged.meetingContent,
      topics: chatDraft.meetingContent.topics,
    };
  }
  if (!hasQa(merged) && chatDraft.questionsAndAnswers?.length) {
    merged.questionsAndAnswers = chatDraft.questionsAndAnswers;
  }
  if (!hasDecisions(merged) && chatDraft.decisions?.length) {
    merged.decisions = chatDraft.decisions;
  }
  if (
    (!merged.openQuestions.length || merged.openQuestions.every((q) => !q.trim())) &&
    chatDraft.openQuestions?.length
  ) {
    merged.openQuestions = chatDraft.openQuestions;
  }
  if (!hasApproval(merged) && chatDraft.approval) {
    merged.approval = chatDraft.approval;
  }
  if (chatDraft.participants) {
    const cp = chatDraft.participants.customer.people;
    const ep = chatDraft.participants.executor.people;
    if (cp.length && !merged.participants.customer.people.some((p) => p.fullName.trim())) {
      merged.participants.customer = { ...merged.participants.customer, people: cp };
    }
    if (ep.length && !merged.participants.executor.people.some((p) => p.fullName.trim())) {
      merged.participants.executor = { ...merged.participants.executor, people: ep };
    }
    if (chatDraft.participants.customer.organizationName.trim()) {
      merged.participants.customer.organizationName = chatDraft.participants.customer.organizationName;
    }
    if (chatDraft.participants.executor.organizationName.trim()) {
      merged.participants.executor.organizationName = chatDraft.participants.executor.organizationName;
    }
  }

  return merged;
}

/** Краткая выжимка для промпта document-agent (приоритет над расшифровкой). */
export function formatChatDraftForPrompt(draft: Partial<Protocol>): string {
  if (!draft || Object.keys(draft).length === 0) return '';

  const lines: string[] = [
    '### СОГЛАСОВАНО С ПОЛЬЗОВАТЕЛЕМ В ЧАТЕ (ответ «Верно») — ОБЯЗАТЕЛЬНО перенеси в JSON дословно',
  ];

  if (draft.termsAndDefinitions?.length) {
    lines.push('\n**Раздел 4 — термины:**');
    draft.termsAndDefinitions.forEach((t) => lines.push(`- ${t.term} — ${t.definition}`));
  }
  if (draft.abbreviations?.length) {
    lines.push('\n**Раздел 5 — сокращения:**');
    draft.abbreviations.forEach((a) => lines.push(`- ${a.abbreviation} — ${a.fullForm}`));
  }
  if (draft.meetingContent?.topics?.length) {
    lines.push('\n**Раздел 6 — содержание (темы):**');
    draft.meetingContent.topics.forEach((t) => lines.push(`- ${t.title}: ${t.content}`));
  }
  if (draft.questionsAndAnswers?.length) {
    lines.push('\n**Раздел 7 — вопросы и ответы:**');
    draft.questionsAndAnswers.forEach((qa) => {
      lines.push(`Вопрос: ${qa.question}`);
      lines.push(`Ответ: ${qa.answer}`);
    });
  }
  if (draft.decisions?.length) {
    lines.push('\n**Раздел 8 — решения:**');
    draft.decisions.forEach((d) => {
      lines.push(`Решение: ${d.decision}`);
      lines.push(`Ответственный: ${d.responsible}`);
    });
  }
  if (draft.openQuestions?.length) {
    lines.push('\n**Раздел 9 — открытые вопросы:**');
    draft.openQuestions.forEach((q) => lines.push(`- ${q}`));
  }
  if (draft.approval) {
    lines.push('\n**Раздел 10 — согласование:**');
    lines.push(
      `Исполнитель: ${draft.approval.executorSignature.representative}; Заказчик: ${draft.approval.customerSignature.representative}`,
    );
  }

  return lines.join('\n');
}
