import type { MeetingQuestion, Protocol, ResumeRow } from '@/lib/schemas/protocol-schema';
import { cleanProtocolText, isAgendaMetaLine, isValidParticipantRow, stripProtocolTimecodes, formatDecidedForOutput } from '@/lib/protocol-markdown-format';
import { buildResumeFromMeetingQuestions, extractListenedParticipantNames, finalizeProtocol } from '@/lib/protocol-sanitize';
import { coerceProtocolPartial } from '@/lib/schemas/protocol-schema';

export { mergeProtocolWithChatDraft, finalizeProtocol } from '@/lib/protocol-sanitize';

type ChatTurn = { role: string; text: string };

const USER_CONFIRM_RX =
  /^(верно|да|ок|окей|ладно|всё\s*верно|все\s*верно|согласен|подтверждаю|к\s+следующему|далее|продолжай|хорошо|роман\s+не\s+нужен|убираю\s+романа|не\s+заказчик|исполнитель|исправл)([.!?,]|\s|$)/i;

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

function uiMessagesToTurns(uiMessages: unknown[]): ChatTurn[] {
  return uiMessages
    .map((msg) => ({
      role: String((msg as Record<string, unknown>)?.role ?? ''),
      text: extractUiMessageText(msg),
    }))
    .filter((t) => t.text.trim().length > 0);
}

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

function extractSection(text: string, startLabel: string, endLabels: string[] = ['Обсудили:', 'Решили:', 'Резюме:']): string {
  const startRe = new RegExp(`${startLabel}\\s*`, 'i');
  const startM = text.match(startRe);
  if (!startM || startM.index == null) return '';
  let tail = text.slice(startM.index + startM[0].length);
  for (const endLabel of endLabels) {
    const endRe = new RegExp(`\\n\\s*${endLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
    const endM = tail.match(endRe);
    if (endM?.index != null) tail = tail.slice(0, endM.index);
  }
  return tail.trim();
}

function parseHeaderFromBlocks(blocks: string[]): Partial<Protocol> {
  const draft: Partial<Protocol> = {};
  for (const block of blocks) {
    if (!/протокол|договор|тема договора|дата собрания|номер протокола/i.test(block)) continue;

    const numM =
      block.match(/ПРОТОКОЛ\s*№\s*(\d+)/i) || block.match(/Номер протокола:\s*(\d+)/i);
    if (numM) draft.protocolNumber = numM[1];

    const dateM =
      block.match(/ОТ\s+(\d{1,2}\.\d{1,2}\.\d{4})/i) ||
      block.match(/(?:^|\n)Дата:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (dateM) draft.protocolDate = dateM[1];

    const titleM =
      block.match(/(?:^|\n)Название протокола:\s*([^\n]+)/i) ||
      block.match(/(?:^|\n)Повестка:\s*([^\n]+)/i);
    if (titleM) draft.protocolTitle = cleanProtocolText(titleM[1]);

    const contractM =
      block.match(/Договор\s*№\s*([^\s]+)\s+от\s*([^\n]+)/i) ||
      block.match(/Договор:\s*№?\s*(\d+)/i);
    if (contractM) {
      const num = contractM[1].replace(/^№/, '').trim();
      if (num && !/не\s+указан/i.test(num)) draft.contractNumber = num;
      if (contractM[2] && !/не\s+указан/i.test(contractM[2])) {
        draft.contractDate = cleanProtocolText(contractM[2]);
      }
    }

    const topicM = block.match(/Тема договора:\s*[«"]?([^»"\n]+)[»"]?/i);
    if (topicM) draft.contractTopic = cleanProtocolText(topicM[1]);

    const assemblyM =
      block.match(/Дата собрания:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i) ||
      block.match(/дата собрания[^:\n]*:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (assemblyM) draft.assemblyDate = assemblyM[1];
  }
  if (!draft.assemblyDate && draft.protocolDate) draft.assemblyDate = draft.protocolDate;
  return draft;
}

/** Тема договора из вступления («встреча посвящена…»), если отдельно не названа. */
function inferContractTopicFromBlocks(blocks: string[]): string {
  for (const block of blocks) {
    const explicit = block.match(/Тема договора:\s*[«"]?([^»"\n]+)[»"]?/i);
    if (explicit?.[1]) return cleanProtocolText(explicit[1]);

    const meeting =
      block.match(/встреча\s+посвящен[ао]\s+([^.\n]+)/i) ||
      block.match(/посвящен[ао]\s+(?:задаче\s+)?([^.\n]+)/i) ||
      block.match(/задаче\s+по\s+([^.\n]+)/i);
    if (meeting?.[1]) return cleanProtocolText(meeting[1]);
  }
  return '';
}

function scoreAgendaBlock(items: string[]): number {
  const valid = items.filter((x) => x.trim() && !isAgendaMetaLine(x));
  if (valid.length < 1 || valid.length > 12) return -1;
  const avgLen = valid.reduce((s, x) => s + x.length, 0) / valid.length;
  if (avgLen > 220) return -1;
  return valid.length * 15;
}

function parseAgendaFromBlocks(blocks: string[]): string[] {
  const byNumber = new Map<number, string>();
  let bestList: string[] = [];
  let bestScore = -1;

  for (const block of blocks) {
    if (!/повестк|раздел\s*2/i.test(block)) continue;
    if (/слушали:|обсудили:|решили:/i.test(block) && !/^\s*\d+[.)]/m.test(block)) continue;

    const items: string[] = [];
    for (const rawLine of block.split('\n')) {
      let line = stripProtocolTimecodes(rawLine.trim());
      if (!line || /верно\??$/i.test(line)) continue;
      if (isAgendaMetaLine(line)) continue;

      const numbered = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
      if (numbered) {
        const n = parseInt(numbered[1], 10);
        const text = cleanProtocolText(numbered[2]);
        if (text && !isAgendaMetaLine(text)) {
          byNumber.set(n, text);
          items.push(text);
        }
        continue;
      }

      if (
        line.length > 20 &&
        /^[А-ЯЁ]/.test(line) &&
        !line.includes('|') &&
        !/^(отлично|теперь|перейд|предлагаю)/i.test(line) &&
        (/^Обсуждение/i.test(line) || /^Организационные/i.test(line))
      ) {
        items.push(cleanProtocolText(line));
      }
    }

    const score = scoreAgendaBlock(items);
    if (score > bestScore) {
      bestScore = score;
      bestList = items;
    }
  }

  if (byNumber.size > 0) {
    return [...byNumber.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
  }
  return bestList.filter(Boolean);
}

/** Сторона только из явной разметки чата (заголовок раздела или метка Заказчик/Исполнитель). */
function sideFromRoleLabel(text: string): 'customer' | 'executor' | null {
  const t = text.trim();
  if (!t) return null;
  if (/^заказчик$/i.test(t) || (/заказчик/i.test(t) && !/исполнитель/i.test(t))) return 'customer';
  if (/^исполнитель$/i.test(t) || /исполнитель/i.test(t)) return 'executor';
  return null;
}

function resolveParticipantSide(
  position: string,
  explicit: 'customer' | 'executor' | null,
): 'customer' | 'executor' | null {
  if (explicit) return explicit;
  return sideFromRoleLabel(position);
}

function parseOrganizationNamesFromBlocks(blocks: string[]): {
  customer: string;
  executor: string;
} {
  let customer = 'Заказчик';
  let executor = 'Исполнитель';
  for (const block of blocks) {
    if (!/участник|раздел\s*3|согласован|раздел\s*5/i.test(block)) continue;
    for (const rawLine of block.split('\n')) {
      const line = stripProtocolTimecodes(rawLine.trim());
      const custM = line.match(/^заказчик\s*:\s*(.+)$/i);
      if (custM?.[1]?.trim() && !/^(заказчик|исполнитель)$/i.test(custM[1].trim())) {
        customer = cleanProtocolText(custM[1]);
      }
      const execM = line.match(/^исполнитель\s*:\s*(.+)$/i);
      if (execM?.[1]?.trim() && !/^(заказчик|исполнитель)$/i.test(execM[1].trim())) {
        executor = cleanProtocolText(execM[1]);
      }
    }
  }
  return { customer, executor };
}

function parseParticipantsFromBlocks(blocks: string[]): Protocol['participants'] | undefined {
  let customerPeople: Protocol['participants']['customer']['people'] = [];
  let executorPeople: Protocol['participants']['executor']['people'] = [];
  let bestBlock = '';

  for (const block of blocks) {
    if (!/участник|раздел\s*3/i.test(block)) continue;
    if (/слушали:|обсудили:|решили:/i.test(block)) continue;
    if (block.length > bestBlock.length) bestBlock = block;
  }

  const blocksToScan = bestBlock ? [bestBlock, ...blocks.filter((b) => b !== bestBlock)] : blocks;

  const pushPerson = (
    side: 'customer' | 'executor',
    fullName: string,
    position: string,
  ) => {
    if (!fullName) return;
    if (!isValidParticipantRow(fullName, position)) return;
    const row = {
      fullName,
      position: position.trim() || (side === 'customer' ? 'Заказчик' : 'Исполнитель'),
    };
    if (side === 'customer') customerPeople.push(row);
    else executorPeople.push(row);
  };

  for (const block of blocksToScan) {
    if (!/участник|раздел\s*3/i.test(block)) continue;
    if (/слушали:|обсудили:|решили:/i.test(block)) continue;

    let side: 'customer' | 'executor' | null = null;

    for (const rawLine of block.split('\n')) {
      const line = stripProtocolTimecodes(rawLine.trim());
      if (!line) continue;

      if (/^заказчик\s*:?\s*$/i.test(line)) {
        side = 'customer';
        continue;
      }
      if (/^исполнитель\s*:?\s*$/i.test(line)) {
        side = 'executor';
        continue;
      }

      const tabCells = line.split('\t').map((c) => c.trim()).filter(Boolean);
      if (tabCells.length >= 2 && !/^(фио|должность|сторона)$/i.test(tabCells[0])) {
        const resolved = resolveParticipantSide(tabCells[1], side);
        if (resolved) {
          pushPerson(resolved, cleanProtocolText(tabCells[0]), cleanProtocolText(tabCells[1]));
        }
        continue;
      }

      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (
        side &&
        cells.length >= 2 &&
        !/^(заказчик|исполнитель|фио|должность|сторона)$/i.test(cells[0])
      ) {
        const nameM = cells[0].match(/^([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/)?.[1];
        if (nameM) {
          pushPerson(side, nameM, cells[1] || cells[0].replace(nameM, '').trim());
        }
        continue;
      }

      const dash = line.match(/^([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)\s*[—–-]\s*(.+?)\.?\s*$/);
      if (dash) {
        const fullName = cleanProtocolText(dash[1]);
        const position = cleanProtocolText(dash[2]);
        const resolved = resolveParticipantSide(position, side);
        if (resolved) pushPerson(resolved, fullName, position);
        continue;
      }

      const paren = line.match(/^([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)\s*\(([^)]+)\)/);
      if (paren) {
        const fullName = cleanProtocolText(paren[1]);
        const roleText = cleanProtocolText(paren[2]);
        const resolved = sideFromRoleLabel(roleText) ?? side;
        if (resolved) pushPerson(resolved, fullName, roleText);
      }
    }
  }

  const dedupe = (rows: Protocol['participants']['customer']['people']) => {
    const seen = new Set<string>();
    return rows.filter((p) => {
      const k = p.fullName.toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  customerPeople = dedupe(customerPeople);
  executorPeople = dedupe(executorPeople);

  if (customerPeople.length === 0 && executorPeople.length === 0) return undefined;
  const orgs = parseOrganizationNamesFromBlocks(blocks);
  return {
    customer: { organizationName: orgs.customer, people: customerPeople },
    executor: { organizationName: orgs.executor, people: executorPeople },
  };
}

function inferQuestionTitle(block: string, fallbackIndex: number, agendaItems: string[]): string {
  const itemM = block.match(/Пункт повестки\s*(\d+)\s*:\s*([^\n.]+)/i);
  if (itemM?.[2]) {
    const idx = parseInt(itemM[1], 10) - 1;
    if (agendaItems[idx]) return cleanProtocolText(agendaItems[idx]);
    return cleanProtocolText(itemM[2]);
  }
  const numbered = block.match(/^\s*1\)\s+([^\n.]+)/im);
  if (numbered?.[1] && !isAgendaMetaLine(numbered[1])) return cleanProtocolText(numbered[1]);
  const patterns = [
    /(?:Начнём|Переходим|Начну с)[^\n]*пункт[^\n]*:\s*([^\n.]+)/i,
    /(?:первому|второму|третьему)\s+пункту\s+повестки:\s*([^\n.]+)/i,
    /по пункту повестки:\s*\n?\s*1\)\s+([^\n.]+)/i,
  ];
  for (const rx of patterns) {
    const m = block.match(rx);
    if (m?.[1] && !isAgendaMetaLine(m[1])) return cleanProtocolText(m[1]);
  }
  return agendaItems[fallbackIndex] ?? `Вопрос ${fallbackIndex + 1}`;
}

function isMeetingContentBlock(block: string): boolean {
  if (!/слушали:/i.test(block) || !/обсудили:/i.test(block) || !/решили:/i.test(block)) {
    return false;
  }
  if (/переходим к разделу\s*5\s*\(\s*согласован/i.test(block) && !/пункт повестки\s*№?\s*\d/i.test(block)) {
    return false;
  }
  if (
    /план дальнейших действий|группу в telegram|загрузить видеозапись|дополнительных встреч/i.test(block) &&
    !/пункт повестки\s*№?\s*[1-4]/i.test(block)
  ) {
    return false;
  }
  if (/предлагаю добавить в повестку/i.test(block) && !/раздел\s*4|1\)\s+Обсуждение/i.test(block)) {
    return false;
  }
  if (/перехожу к разделу 2|разделу 2\.\s*повестка/i.test(block) && !/раздел\s*4/i.test(block)) {
    return false;
  }
  return /раздел\s*4|пункт повестки\s*№?\s*\d|1\)\s+Обсуждение|Начну с первого блока|по пункту повестки/i.test(
    block,
  );
}

function meetingBlockAgendaIndex(block: string): number | null {
  const m = block.match(/пункт повестки\s*№?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10) - 1;
  const numbered = block.match(/^\s*(\d+)\)\s+/im);
  if (numbered) return parseInt(numbered[1], 10) - 1;
  return null;
}

function blockContentScore(q: MeetingQuestion): number {
  return (q.listened?.length ?? 0) + (q.discussed?.length ?? 0) + (q.decided?.length ?? 0);
}

function parseMeetingQuestionsFromBlocks(blocks: string[], agendaItems: string[]): MeetingQuestion[] {
  const byIndex = new Map<number, MeetingQuestion>();
  let fallbackIdx = 0;

  for (const block of blocks) {
    if (!isMeetingContentBlock(block)) continue;

    const listenedRaw = extractSection(block, 'Слушали:', ['Обсудили:', 'Решили:', 'Резюме:']);
    const discussedRaw = extractSection(block, 'Обсудили:', ['Решили:', 'Резюме:']);
    const decidedRaw = extractSection(block, 'Решили:', ['Резюме:']);

    if (!listenedRaw && !discussedRaw && !decidedRaw) continue;

    const idx = meetingBlockAgendaIndex(block) ?? fallbackIdx++;
    const question = inferQuestionTitle(block, idx, agendaItems);
    if (isAgendaMetaLine(question)) continue;

    const entry: MeetingQuestion = {
      question: agendaItems[idx] ? cleanProtocolText(agendaItems[idx]) : question,
      listened: extractListenedParticipantNames(listenedRaw),
      discussed: cleanProtocolText(discussedRaw),
      decided: formatDecidedForOutput(decidedRaw),
    };

    const prev = byIndex.get(idx);
    if (!prev || blockContentScore(entry) > blockContentScore(prev)) {
      byIndex.set(idx, entry);
    }
  }

  if (agendaItems.length === 0) {
    return [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, q]) => q);
  }

  const out: MeetingQuestion[] = [];
  for (let i = 0; i < agendaItems.length; i++) {
    const q = byIndex.get(i);
    if (q) out.push(q);
  }
  return out;
}

function isApprovalBlock(block: string): boolean {
  if (!/согласован|раздел\s*5/i.test(block)) return false;
  if (/пункт повестки\s*№?\s*\d/i.test(block)) return false;
  if (/слушали:/i.test(block) && /обсудили:/i.test(block) && /решили:/i.test(block)) return false;
  return true;
}

function parseApprovalFromBlocks(
  blocks: string[],
  participants?: Protocol['participants'],
): Protocol['approval'] | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (!isApprovalBlock(block)) continue;

    let scanBlock = block;
    const sodIdx = block.search(/\n\s*слушали:/i);
    if (sodIdx > 0) scanBlock = block.slice(0, sodIdx);

    const customerSigs: string[] = [];
    const execSigs: string[] = [];
    let side: 'customer' | 'executor' | null = null;

    for (const rawLine of scanBlock.split('\n')) {
      const line = stripProtocolTimecodes(rawLine.trim());
      if (!line) continue;
      if (/^заказчик\s*:?\s*$/i.test(line)) {
        side = 'customer';
        continue;
      }
      if (/^исполнитель\s*:?\s*$/i.test(line)) {
        side = 'executor';
        continue;
      }
      const nameM = line.match(/^([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/);
      if (!nameM) continue;
      const name = cleanProtocolText(nameM[1]);
      if (!name) continue;
      if (side === 'customer') customerSigs.push(name);
      else if (side === 'executor') execSigs.push(name);
    }

    if (customerSigs.length === 0 && participants?.customer.people.length) {
      customerSigs.push(...participants.customer.people.map((p) => p.fullName).filter(Boolean));
    }
    if (execSigs.length === 0 && participants?.executor.people.length) {
      execSigs.push(...participants.executor.people.map((p) => p.fullName).filter(Boolean));
    }

    const orgs = parseOrganizationNamesFromBlocks(blocks);
    return {
      customer: { organizationName: orgs.customer, signatories: customerSigs },
      executor: { organizationName: orgs.executor, signatories: execSigs },
    };
  }
  return undefined;
}

export function buildProtocolDraftFromChat(uiMessages: unknown[]): Partial<Protocol> {
  const blocks = collectUserConfirmedAssistantBlocks(uiMessages);
  if (blocks.length === 0) return {};

  const header = parseHeaderFromBlocks(blocks);
  const agendaItems = parseAgendaFromBlocks(blocks);
  const participants = parseParticipantsFromBlocks(blocks);
  const meetingQuestions = parseMeetingQuestionsFromBlocks(blocks, agendaItems);
  const approval = parseApprovalFromBlocks(blocks, participants);

  const draft: Partial<Protocol> = { ...header };
  if (!draft.contractTopic) {
    const inferredTopic = inferContractTopicFromBlocks(blocks);
    if (inferredTopic) draft.contractTopic = inferredTopic;
  }
  if (header.assemblyDate) draft.assemblyDate = header.assemblyDate;
  if (agendaItems.length) draft.agendaItems = agendaItems;
  if (participants) draft.participants = participants;
  if (meetingQuestions.length) draft.meetingQuestions = meetingQuestions;
  if (meetingQuestions.length) draft.resume = buildResumeFromMeetingQuestions(meetingQuestions);
  if (approval) draft.approval = approval;

  return draft;
}

export function formatChatDraftForPrompt(draft: Partial<Protocol>): string {
  if (!draft || Object.keys(draft).length === 0) return '';

  const lines: string[] = [
    '### СОГЛАСОВАНО С ПОЛЬЗОВАТЕЛЕМ В ЧАТЕ (ответ «Верно») — перенеси в JSON ДОСЛОВНО, без тайм-кодов',
    'Роли участников (Заказчик/Исполнитель) — только как зафиксировал ассистент в чате; не выводи сторону из названий компаний.',
    'Повестка — только согласованные пункты, НЕ дублируй подпункты из расшифровки.',
    'Если дата собрания уже в шапке — раздел 1 не переспрашивай.',
    'Раздел 4: ровно столько блоков, сколько пунктов повестки. «Слушали» — только ФИО (Заказчик/Исполнитель).',
  ];

  if (draft.protocolNumber || draft.protocolDate || draft.protocolTitle) {
    lines.push('\n**Шапка:**');
    if (draft.protocolNumber) lines.push(`Номер: ${draft.protocolNumber}`);
    if (draft.protocolDate) lines.push(`Дата протокола: ${draft.protocolDate}`);
    if (draft.protocolTitle) lines.push(`Название: ${draft.protocolTitle}`);
    if (draft.contractNumber) lines.push(`Договор №${draft.contractNumber} от ${draft.contractDate ?? '…'}`);
    if (draft.contractTopic) lines.push(`Тема договора: ${draft.contractTopic}`);
  }
  if (draft.assemblyDate) lines.push(`\n**1. Дата собрания:** ${draft.assemblyDate}`);
  if (draft.agendaItems?.length) {
    lines.push('\n**2. Повестка:**');
    draft.agendaItems.forEach((item, i) => lines.push(`${i + 1}) ${item}`));
  }
  if (draft.participants) {
    lines.push('\n**3. Участники:**');
    draft.participants.executor.people.forEach((p) => lines.push(`Исполнитель: ${p.fullName} — ${p.position}`));
    draft.participants.customer.people.forEach((p) => lines.push(`Заказчик: ${p.fullName} — ${p.position}`));
  }
  if (draft.meetingQuestions?.length) {
    lines.push('\n**4. Содержание встречи:**');
    draft.meetingQuestions.forEach((q, i) => {
      lines.push(`${i + 1}) ${q.question}`);
      if (q.listened) lines.push(`Слушали: ${q.listened}`);
      if (q.discussed) lines.push(`Обсудили: ${q.discussed}`);
      if (q.decided) lines.push(`Решили: ${q.decided}`);
    });
  }
  if (draft.resume?.length) {
    lines.push('\n**Резюме:**');
    draft.resume.forEach((r) => {
      lines.push(`Вопрос: ${r.discussedQuestion}`);
      lines.push(`Решение: ${r.decision}`);
      if (r.deadline) lines.push(`Срок: ${r.deadline}`);
      if (r.responsible) lines.push(`Ответственный: ${r.responsible}`);
    });
  }
  if (draft.approval) {
    lines.push('\n**5. Согласовано:**');
    draft.approval.executor.signatories.forEach((s) => lines.push(`Исполнитель: ${s}`));
  }

  return lines.join('\n');
}

export function isChatDraftComplete(draft: Partial<Protocol>): boolean {
  const agenda = draft.agendaItems?.length ?? 0;
  const questions = draft.meetingQuestions?.length ?? 0;
  const customer = draft.participants?.customer.people.length ?? 0;
  const executor = draft.participants?.executor.people.length ?? 0;
  return Boolean(
    draft.protocolNumber &&
      draft.protocolDate &&
      agenda >= 1 &&
      customer >= 1 &&
      executor >= 1 &&
      questions >= 1 &&
      questions === agenda,
  );
}

export function buildProtocolFromChatOnly(uiMessages: unknown[]): Protocol | null {
  const draft = buildProtocolDraftFromChat(uiMessages);
  if (!isChatDraftComplete(draft)) return null;
  return finalizeProtocol(coerceProtocolPartial(draft));
}
