import type { Protocol } from '@/lib/schemas/protocol-schema';
import { isValidParticipantRow } from '@/lib/protocol-markdown-format';
import { isProtocolBoilerplateLine } from '@/lib/protocol-markdown-format';

type ChatTurn = { role: string; text: string };

/**
 * ЧИСТОЕ подтверждение — всё сообщение целиком состоит из слов согласия.
 * Раньше «да, но исправь X» считалось подтверждением (матч по началу строки),
 * из-за чего ошибочный блок попадал в «подтверждённые», а сама правка терялась.
 * Теперь сообщение с любым дополнительным содержанием — это правка, и решать,
 * что с ней делать, будет модель (см. extractLatestUserCorrections).
 */
const PURE_CONFIRM_RX =
  /^(?:(?:верно|да|ок|окей|ладно|согласен|подтверждаю|далее|продолжай|хорошо|всё\s*верно|все\s*верно|к\s+следующему|да,?\s*(?:всё|все)\s*верно)[\s.!?)]*)+$/i;

function isPureConfirmation(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 60 && PURE_CONFIRM_RX.test(t);
}

/** Слова согласия в начале сообщения — отбрасываем, чтобы добраться до сути. */
const AGREE_PREFIX_RX =
  /^(?:(?:верно|да|ок|окей|ладно|согласен|подтверждаю|хорошо|всё\s*верно|все\s*верно)[\s,.!?—-]*)+/i;

/**
 * Команда «опубликуй документ» — распоряжение, а не содержательная правка.
 *
 * Без `\b`: в JavaScript граница слова определяется по ASCII, поэтому после
 * кириллической буквы («собирай») её просто нет и выражение никогда не
 * срабатывает. Границы задаём явными пробелами.
 */
const PUBLISH_CMD_RX =
  /^(?:собирай|собери|сформируй|формируй|сделай|генерируй|публикуй|оформи|обнови)(?:\s[^.!?]*)?\s(?:протокол|документ)[^.!?]*[.!?]?$/i;

/** Признаки того, что в сообщении есть содержательное требование, а не только команда. */
const EDIT_HINT_RX =
  /(замен|помен|исправ|добав|убер|удали|укажи|поставь|измен|переимен|вместо|должност|срок|ответственн|фамили|назван)/i;

/**
 * «Да, всё верно. Собирай протокол целиком.» — это подтверждение с командой
 * публикации, а не правка. Такие сообщения раньше попадали в список правок и
 * разбавляли настоящие: document-agent получал пять равноправных «Правка N»,
 * из которых содержательной была одна, и терял её при пересборке всех разделов.
 *
 * Осторожность: «Собери протокол и замени должность Ирины» — уже правка, её
 * терять нельзя. Поэтому сообщение с любым признаком содержательного
 * требования командой не считается.
 */
function isPublishCommand(text: string): boolean {
  const rest = text.trim().replace(AGREE_PREFIX_RX, '').trim();
  if (!rest || rest.length > 90) return false;
  if (EDIT_HINT_RX.test(rest)) return false;
  return PUBLISH_CMD_RX.test(rest);
}

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
    if (user.role !== 'user' || !isPureConfirmation(user.text)) continue;
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

/** Максимум содержательных сообщений пользователя, передаваемых модели как правки. */
function protocolMaxCorrections(): number {
  const n = Number(process.env.PROTOCOL_MAX_CORRECTIONS);
  return Number.isFinite(n) && n > 0 ? n : 8;
}

/** Сообщения длиннее этого — вероятно, вставленная расшифровка, а не правка. */
function protocolMaxCorrectionChars(): number {
  const n = Number(process.env.PROTOCOL_MAX_CORRECTION_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/** Сообщения длиннее этого исключаются из «ответов пользователя» (см. extractUserAnswerTexts). */
function protocolUserAnswerMaxChars(): number {
  const n = Number(process.env.PROTOCOL_USER_ANSWER_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

/** Построчный паттерн реплик расшифровки: «[00:01:15] — …» / «Спикер 1: …». */
const TRANSCRIPT_LINE_RX = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*[—–-]|Спикер\s+\d+\s*:)/gm;

/** ≥3 строк-реплик подряд — это вставленная расшифровка, а не текст правки. */
function looksLikeTranscript(text: string): boolean {
  const matches = text.match(TRANSCRIPT_LINE_RX);
  return Boolean(matches && matches.length >= 3);
}

/**
 * Возвращает содержательные сообщения пользователя (в хронологическом порядке,
 * последние protocolMaxCorrections()) — это указания и правки, которые модель
 * должна учесть при генерации. Раньше брались только сообщения ПОСЛЕ последнего
 * подтверждения: правка «исправь Слушали», за которой следовало «верно»,
 * выпадала из контекста и документ откатывался к старой версии. Теперь мы не
 * пытаемся regex-логикой угадать, что из сказанного — правка: отдаём модели
 * всё содержательное, приоритет по хронологии определяет она сама.
 *
 * Сообщения длиннее лимита раньше молча отбрасывались — терялись реальные
 * длинные правки. Теперь отбрасываются только похожие на вставленную
 * расшифровку (по построчному паттерну реплик); остальные — обрезаются
 * до лимита с явным маркером, чтобы пользователь проверил раздел вручную.
 */
export function extractLatestUserCorrections(uiMessages: unknown[]): string[] {
  const turns = uiMessagesToTurns(uiMessages);
  const maxChars = protocolMaxCorrectionChars();
  const corrections: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = turn.text.trim();
    // Пропускаем: пустые/короткие, чистые подтверждения и команды публикации.
    if (text.length < 15) continue;
    if (isPureConfirmation(text)) continue;
    if (isPublishCommand(text)) continue;
    if (text.length > maxChars) {
      if (looksLikeTranscript(text)) continue; // вставленная расшифровка — пропускаем, как раньше
      corrections.push(
        `${text.slice(0, maxChars)}…[правка обрезана до ${maxChars} символов — проверьте этот раздел в готовом документе]`,
      );
      continue;
    }
    corrections.push(text);
  }
  return corrections.slice(-protocolMaxCorrections());
}

/**
 * Видимые тексты ответов пользователя (роль user) — источник для гардов
 * реквизитов договора/шапки (fillContractFromDialogue/fillHeaderFromDialogue).
 * В отличие от полного conversationContext, сюда НЕ попадает текст вложенной
 * расшифровки — она приходит в metadata.hiddenTexts, а не в тексте хода
 * пользователя, поэтому случайные упоминания «договор №…» из расшифровки
 * сюда не просачиваются. Сообщения длиннее лимита (почти наверняка вставленный
 * текст, а не ответ) исключаются.
 */
export function extractUserAnswerTexts(uiMessages: unknown[]): string[] {
  const turns = uiMessagesToTurns(uiMessages);
  const maxChars = protocolUserAnswerMaxChars();
  return turns
    .filter((t) => t.role === 'user')
    .map((t) => t.text.trim())
    .filter((text) => text.length >= 3 && text.length <= maxChars);
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
        // Блок мог содержать таблицу резюме — её заголовки/строки не участники.
        if (/обсуждаем|принятые\s+решени|вопрос|повестк|срок\s*:|ответствен/i.test(fullName)) continue;
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
 * ПРИОРИТЕТ у МОДЕЛИ: она видит полную историю диалога, включая правки после
 * подтверждений, и применяет их при генерации. Regex-черновик из чата — только
 * страховка от ПУСТЫХ разделов (модель вернула пустую повестку/участников/
 * содержание). Раньше приоритет был у чат-драфта, и устаревший «подтверждённый»
 * блок откатывал правки, которые модель уже применила (старое «Слушали»,
 * потерянная роль участника).
 */
export function mergeProtocolWithChatDraft(model: Protocol, chatDraft: Partial<Protocol>): Protocol {
  if (!chatDraft || Object.keys(chatDraft).length === 0) return model;
  const merged: Protocol = { ...model };
  // Модель важнее; чат — фолбэк для пустых значений.
  const pick = (modelVal: string, chatVal: string): string =>
    isRealValue(modelVal) ? modelVal : (chatVal ?? '');

  // Повестка: чат подставляется, только если модель вернула пустую.
  if (chatDraft.agenda?.items?.length && !merged.agenda.items.some((it) => isRealValue(it))) {
    merged.agenda = { items: chatDraft.agenda.items };
  }

  // Содержание: темы модели — основа; пустые поля добираем из чата по заголовку.
  if (chatDraft.meetingContent?.topics?.length) {
    const chatTopics = chatDraft.meetingContent.topics;
    if (merged.meetingContent.topics.length === 0) {
      merged.meetingContent = { ...merged.meetingContent, topics: chatTopics };
    } else {
      const topics = merged.meetingContent.topics.map((m, idx) => {
        const c =
          chatTopics.find((x) => normTopicTitle(x.title) === normTopicTitle(m.title)) ??
          chatTopics[idx];
        return {
          title: pick(m.title, c?.title ?? ''),
          listened: pick(m.listened, c?.listened ?? ''),
          discussed: pick(m.discussed, c?.discussed ?? ''),
          decided: pick(m.decided, c?.decided ?? ''),
        };
      });
      merged.meetingContent = { ...merged.meetingContent, topics };
    }
  }
  if (
    chatDraft.meetingContent?.summary?.length &&
    !merged.meetingContent.summary.some((r) => isRealValue(r.decision))
  ) {
    merged.meetingContent = { ...merged.meetingContent, summary: chatDraft.meetingContent.summary };
  }

  // Согласование: чат подставляется, только если у модели нет подписантов.
  const modelHasSignatories =
    merged.approval.customer.signatories.some((s) => s.trim()) ||
    merged.approval.executor.signatories.some((s) => s.trim());
  if (
    !modelHasSignatories &&
    chatDraft.approval &&
    (chatDraft.approval.customer.signatories.length || chatDraft.approval.executor.signatories.length)
  ) {
    merged.approval = chatDraft.approval;
  }

  // Участники: список модели — основа; пустые должности добираем по имени из чата.
  if (chatDraft.participants) {
    const mergeSide = (side: 'customer' | 'executor') => {
      const chatGrp = chatDraft.participants![side];
      const modelGrp = merged.participants[side];
      const people = modelGrp.people.length
        ? modelGrp.people.map((mp) => {
            const cp = chatGrp.people.find(
              (x) => x.fullName.trim().toLowerCase() === mp.fullName.trim().toLowerCase(),
            );
            return { fullName: mp.fullName, position: pick(mp.position, cp?.position ?? '') };
          })
        : chatGrp.people;
      merged.participants[side] = {
        organizationName: pick(modelGrp.organizationName, chatGrp.organizationName),
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
    // ПОСЛЕДНЯЯ правка — это то, ради чего пользователь прямо сейчас нажал
    // «отправить». Раньше все правки шли одним ровным списком «[Правка N]»,
    // и модель, пересобирая все 10 разделов, теряла её среди старых ответов
    // на вопросы (они тоже попадают в этот список). Выносим её отдельно и
    // первой — до того, как внимание размажется по остальному промпту.
    const all = userCorrections!;
    const latest = all[all.length - 1];
    const earlier = all.slice(0, -1);

    lines.push('\n### 🔴 ТЕКУЩАЯ ПРАВКА — ГЛАВНОЕ ТРЕБОВАНИЕ ЭТОЙ ГЕНЕРАЦИИ');
    lines.push(
      'Применить ОБЯЗАТЕЛЬНО и в первую очередь. Она перекрывает и расшифровку, ' +
        'и согласованные разделы, и все правки ниже. Если её невозможно применить — ' +
        'оставь на этом месте «⚠️ требует уточнения», но не игнорируй молча.',
    );
    lines.push(latest);

    if (earlier.length > 0) {
      lines.push(
        '\n### Ранее сказанное пользователем (фон; более поздние перекрывают более ранние, ' +
          'все — поверх согласованных разделов):',
      );
      earlier.forEach((c, i) => {
        lines.push(`[${i + 1}]: ${c}`);
      });
    }
  }

  return lines.join('\n');
}
