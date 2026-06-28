import type { Protocol } from '@/lib/schemas/protocol-schema';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';
import { isProtocolBoilerplateLine } from '@/lib/protocol-markdown-format';

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

/** Извлекает темы содержания встречи в формате Слушали/Обсудили/Решили. Возвращает из ПОСЛЕДНЕГО подходящего блока. */
function parseMeetingTopicsFromBlocks(blocks: string[]): Protocol['meetingContent']['topics'] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!/содержание встречи|слушали|обсудили|решили|раздел\s*4/i.test(block)) continue;
    const topics: Protocol['meetingContent']['topics'] = [];

    const topicBlocks = block.split(/\n(?=\d+\))/);
    for (const tb of topicBlocks) {
      const titleM = tb.match(/^(\d+\)\s*.+?)(?:\n|$)/);
      if (!titleM) continue;
      const title = stripTimecodes(titleM[1].trim());
      const listenedM = tb.match(/Слушали:\s*([\s\S]*?)(?=Обсудили:|Решили:|$)/i);
      const discussedM = tb.match(/Обсудили:\s*([\s\S]*?)(?=Решили:|Слушали:|$)/i);
      const decidedM = tb.match(/Решили:\s*([\s\S]*?)(?=Обсудили:|Слушали:|$)/i);
      const listened = listenedM ? stripTimecodes(listenedM[1].trim()) : '';
      const discussed = discussedM ? stripTimecodes(discussedM[1].trim()) : '';
      const decided = decidedM ? stripTimecodes(decidedM[1].trim()) : '';
      if (title && (listened || discussed || decided)) {
        topics.push({ title, listened, discussed, decided });
      }
    }
    if (topics.length > 0) return topics;
  }
  return [];
}

/** Извлекает резюме встречи. Возвращает из ПОСЛЕДНЕГО подходящего блока. */
function parseSummaryFromBlocks(blocks: string[]): Protocol['meetingContent']['summary'] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!/резюме|обсуждаемые вопросы|принятые решения/i.test(block)) continue;
    const rows: Protocol['meetingContent']['summary'] = [];
    for (const line of block.split('\n')) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (/обсуждаемые|принятые|---/i.test(cells[0])) continue;
      const question = stripTimecodes(cells[0]);
      const decision = stripTimecodes(cells[1]);
      if (question && decision && !isProtocolBoilerplateLine(question)) {
        rows.push({ question, decision });
      }
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

/** Извлекает пункты повестки из подтверждённых блоков. Возвращает из ПОСЛЕДНЕГО подходящего блока. */
function parseAgendaFromBlocks(blocks: string[]): string[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!/повестк|раздел\s*2/i.test(block)) continue;
    const items: string[] = [];
    for (const line of block.split('\n')) {
      // Нумерованные пункты: "1) Текст", "1. Текст", "1. **Текст**"
      const m = line.trim().match(/^\d+[.)]\s+\*{0,2}(.+?)\*{0,2}([;.]?\s*)$/);
      if (m) {
        const item = stripTimecodes(m[1].trim()).replace(/[;.]$/, '').trim();
        if (item.length > 3 && !/^(верно|да|ок|подтвержд)/i.test(item)) {
          items.push(item);
        }
      }
    }
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * Возвращает сообщения пользователя, пришедшие ПОСЛЕ последнего подтверждения «Верно»/«ок» и т.п.
 * Это правки/дополнения, которые должны перекрывать ранее согласованные блоки.
 */
export function extractLatestUserCorrections(uiMessages: unknown[]): string[] {
  const turns = uiMessagesToTurns(uiMessages);

  let lastConfirmIdx = -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'user' && USER_CONFIRM_RX.test(turns[i].text.trim())) {
      lastConfirmIdx = i;
    }
  }
  if (lastConfirmIdx < 0) return [];

  const corrections: string[] = [];
  for (let i = lastConfirmIdx + 1; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== 'user') continue;
    const text = turn.text.trim();
    // Пропускаем пустые, слишком короткие и повторные подтверждения
    if (text.length < 15 || USER_CONFIRM_RX.test(text)) continue;
    corrections.push(text);
  }
  return corrections;
}

function parseApprovalFromBlocks(blocks: string[]): Protocol['approval'] | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!/согласован|раздел\s*5|подпис/i.test(block)) continue;

    const custSigns: string[] = [];
    const execSigns: string[] = [];
    let custOrg = '';
    let execOrg = '';

    const extractOrgAndSigs = (sec: string): { org: string; sigs: string[] } => {
      // 1. Org name: ООО «...» pattern first, then any "Name:" line
      const oooM = sec.match(/ООО\s*[«"]([^»"]+)[»"]/i);
      let org = oooM ? `ООО «${oooM[1]}»` : '';
      if (!org) {
        for (const line of sec.split('\n')) {
          const t = stripTimecodes(line.trim());
          if (t.endsWith(':') && t.length > 3 && t.length < 150 &&
              !/^(со\s+стороны|подпис)/i.test(t)) {
            org = t.slice(0, -1).trim();
            break;
          }
        }
      }
      // 2. Signatories: person lines only (skip org lines, dashes, ООО headers)
      const sigs: string[] = [];
      for (const line of sec.split('\n')) {
        const clean = stripTimecodes(line.trim());
        if (!clean || clean.length <= 3) continue;
        if (/^[-_]{3,}/.test(clean)) continue;
        if (clean.startsWith('//')) continue;
        if (/^ООО\s/i.test(clean)) continue;
        if (clean.endsWith(':')) continue; // org name lines end with colon
        const sig = clean.replace(/\/+_+.*$/, '').trim();
        if (sig && sig.length > 2) sigs.push(sig);
      }
      return { org, sigs };
    };

    // Ищем блок "Со стороны Заказчика"
    const custSection = block.match(/со\s+стороны\s+заказчика([\s\S]*?)(?=со\s+стороны\s+исполнителя|$)/i);
    if (custSection) {
      const { org, sigs } = extractOrgAndSigs(custSection[1]);
      custOrg = org;
      custSigns.push(...sigs);
    }

    // Ищем блок "Со стороны Исполнителя"
    const execSection = block.match(/со\s+стороны\s+исполнителя([\s\S]*?)(?=со\s+стороны\s+заказчика|$)/i);
    if (execSection) {
      const { org, sigs } = extractOrgAndSigs(execSection[1]);
      execOrg = org;
      execSigns.push(...sigs);
    }

    if (custSigns.length > 0 || execSigns.length > 0) {
      return {
        customer: { organization: custOrg || 'Заказчик', signatories: custSigns },
        executor: { organization: execOrg || 'Исполнитель', signatories: execSigns },
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
    if (!/участник|заказчик|исполнитель/i.test(block)) continue;
    const custSec = block.match(/(?:заказчик|со\s+стороны\s+заказчика)[^]*?(?=(?:исполнитель|со\s+стороны\s+исполнителя)|$)/i);
    const execSec = block.match(/(?:исполнитель|со\s+стороны\s+исполнителя)[^]*/i);

    const parseTable = (sec: string | null, side: 'customer' | 'executor') => {
      if (!sec) return;
      const orgM = sec.match(/[—–-]\s*(.+?)[\n|]/);
      if (orgM) {
        const org = orgM[1].trim();
        if (side === 'customer') custOrg = org;
        else execOrg = org;
      }
      const rows: Protocol['participants']['customer']['people'] = [];
      for (const line of sec.split('\n')) {
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
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
    customer: { organizationName: custOrg || 'Заказчик', people: customerPeople },
    executor: { organizationName: execOrg || 'Исполнитель', people: executorPeople },
  };
}

/** Черновик протокола из сообщений ассистента, подтверждённых пользователем. */
export function buildProtocolDraftFromChat(uiMessages: unknown[]): Partial<Protocol> {
  const blocks = collectUserConfirmedAssistantBlocks(uiMessages);
  if (blocks.length === 0) return {};

  const topics = parseMeetingTopicsFromBlocks(blocks);
  const summary = parseSummaryFromBlocks(blocks);
  const approval = parseApprovalFromBlocks(blocks);
  const participants = parseParticipantsFromBlocks(blocks);
  const agendaItems = parseAgendaFromBlocks(blocks);

  const draft: Partial<Protocol> = {};
  if (agendaItems.length) {
    draft.agenda = { items: agendaItems };
  }
  if (topics.length || summary.length) {
    draft.meetingContent = { topics, summary };
  }
  if (approval) draft.approval = approval;
  if (participants) draft.participants = participants;

  return draft;
}

function hasTopics(p: Protocol): boolean {
  return p.meetingContent.topics.some((t) => t.title.trim() && (t.discussed.trim() || t.decided.trim()));
}

function hasSummary(p: Protocol): boolean {
  return p.meetingContent.summary.some((r) => r.question.trim() && r.decision.trim());
}

function hasApproval(p: Protocol): boolean {
  return Boolean(
    p.approval.customer.signatories.some((s) => s.trim()) ||
    p.approval.executor.signatories.some((s) => s.trim()),
  );
}

/** Нормализует заголовок темы для сопоставления (без номера, регистра, пунктуации). */
function normTopicTitle(t: string): string {
  return String(t || '')
    .toLowerCase()
    .replace(/^\s*\d+[).]\s*/, '')
    .replace(/[^а-яёa-z0-9 ]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Реальное значение: непустое и не «не указан…». */
function isRealValue(v: string): boolean {
  return Boolean(v && v.trim() && !/^не\s+указан/i.test(v.trim()));
}

/**
 * Сливает протокол модели с подтверждённым в чате черновиком.
 * ПРИОРИТЕТ у чата: пользователь видел и правил эти блоки в чате. Модель —
 * только фолбэк для полей, которых в чате нет. Это устраняет потерю роли,
 * договора и «откат» исправленного «Слушали» при повторной генерации.
 */
export function mergeProtocolWithChatDraft(model: Protocol, chatDraft: Partial<Protocol>): Protocol {
  if (!chatDraft || Object.keys(chatDraft).length === 0) return model;
  const merged: Protocol = { ...model };
  const pick = (a: string, b: string): string => (isRealValue(a) ? a : (b ?? ''));

  // Повестка: чат в приоритете.
  if (chatDraft.agenda?.items?.length) {
    merged.agenda = { items: chatDraft.agenda.items };
  }

  // Содержание: чат в приоритете; пустые поля добираем из модели по совпадению заголовка.
  if (chatDraft.meetingContent?.topics?.length) {
    const modelTopics = merged.meetingContent.topics;
    const topics = chatDraft.meetingContent.topics.map((c, idx) => {
      const m =
        modelTopics.find((x) => normTopicTitle(x.title) === normTopicTitle(c.title)) ??
        modelTopics[idx];
      return {
        title: pick(c.title, m?.title ?? ''),
        listened: pick(c.listened, m?.listened ?? ''),
        discussed: pick(c.discussed, m?.discussed ?? ''),
        decided: pick(c.decided, m?.decided ?? ''),
      };
    });
    merged.meetingContent = { ...merged.meetingContent, topics };
  }
  if (chatDraft.meetingContent?.summary?.length) {
    merged.meetingContent = { ...merged.meetingContent, summary: chatDraft.meetingContent.summary };
  }

  // Согласование: чат в приоритете, если есть подписанты.
  if (
    chatDraft.approval &&
    (chatDraft.approval.customer.signatories.length || chatDraft.approval.executor.signatories.length)
  ) {
    merged.approval = chatDraft.approval;
  }

  // Участники: чат в приоритете; должность добираем по имени из модели, если в чате пусто.
  if (chatDraft.participants) {
    const mergeSide = (side: 'customer' | 'executor') => {
      const chatGrp = chatDraft.participants![side];
      const modelGrp = merged.participants[side];
      const people = chatGrp.people.length
        ? chatGrp.people.map((cp) => {
            const mp = modelGrp.people.find(
              (x) => x.fullName.trim().toLowerCase() === cp.fullName.trim().toLowerCase(),
            );
            return { fullName: cp.fullName, position: pick(cp.position, mp?.position ?? '') };
          })
        : modelGrp.people;
      merged.participants[side] = {
        organizationName: pick(chatGrp.organizationName, modelGrp.organizationName),
        people,
      };
    };
    mergeSide('customer');
    mergeSide('executor');
  }

  return merged;
}

/**
 * Краткая выжимка для промпта document-agent.
 * @param userCorrections — правки пользователя после последнего подтверждения; имеют приоритет над согласованными блоками
 */
export function formatChatDraftForPrompt(draft: Partial<Protocol>, userCorrections?: string[]): string {
  const hasContent = draft && Object.keys(draft).length > 0;
  const hasCorrections = userCorrections && userCorrections.length > 0;
  if (!hasContent && !hasCorrections) return '';

  const lines: string[] = [
    '### ПОДТВЕРЖДЁННЫЕ ПОЛЬЗОВАТЕЛЕМ РАЗДЕЛЫ — используй как основу фактов, но ОБЯЗАТЕЛЬНО переформулируй согласно регламенту (официально-деловой стиль, без жаргона, без разговорной речи)',
  ];

  if (draft?.agenda?.items?.length) {
    lines.push('\n**Раздел 2 — повестка (подтверждённые пункты):**');
    draft.agenda.items.forEach((item, i) => {
      lines.push(`${i + 1}) ${item}`);
    });
  }

  if (draft?.meetingContent?.topics?.length) {
    lines.push('\n**Раздел 4 — содержание встречи (темы):**');
    draft.meetingContent.topics.forEach((t, i) => {
      lines.push(`${i + 1}) ${t.title}`);
      if (t.listened) lines.push(`  Слушали: ${t.listened}`);
      if (t.discussed) lines.push(`  Обсудили: ${t.discussed}`);
      if (t.decided) lines.push(`  Решили: ${t.decided}`);
    });
  }
  if (draft?.meetingContent?.summary?.length) {
    lines.push('\n**Раздел 4 — резюме:**');
    draft.meetingContent.summary.forEach((r) => {
      lines.push(`- ${r.question} | ${r.decision}`);
    });
  }
  if (draft?.approval) {
    lines.push('\n**Раздел 5 — согласование:**');
    lines.push(`Заказчик (${draft.approval.customer.organization}): ${draft.approval.customer.signatories.join(', ')}`);
        lines.push(`Исполнитель (${draft.approval.executor.organization}): ${draft.approval.executor.signatories.join(', ')}`);
  }

  if (hasCorrections) {
    lines.push(
      '\n### ⚠️ ПРАВКИ ПОЛЬЗОВАТЕЛЯ (применить ПОВЕРХ согласованных разделов — приоритет выше):',
    );
    userCorrections!.forEach((c, i) => {
      lines.push(`[Правка ${i + 1}]: ${c}`);
    });
  }

  return lines.join('\n');
}
