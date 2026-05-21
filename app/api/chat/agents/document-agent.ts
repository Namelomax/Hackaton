import { createUIMessageStream, JsonToSseTransformStream, streamObject } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import {
  ProtocolSchema,
  coerceProtocolPartial,
  parseProtocolStrict,
  extractNoObjectGeneratedText,
  parseLooseJsonObject,
  type Protocol,
} from '@/lib/schemas/protocol-schema';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { SGR_DOCUMENT_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { ollamaProtocolMaxOutputTokens } from '@/lib/ollama-limits';
import {
  buildProtocolDraftFromChat,
  formatChatDraftForPrompt,
  mergeProtocolWithChatDraft,
} from '@/lib/protocol-chat-extract';
import {
  cleanProtocolText,
  formatProtocolSectionHeading,
  formatContractBlock,
  formatSummaryDecisionForMarkdown,
  isValidParticipantRow,
  resolveApprovalForDocument,
} from '@/lib/protocol-markdown-format';

function extractMessageText(msg: any): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg?.parts)) {
    const texts = msg.parts
      .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean);
    if (texts.length) return texts.join(' ');
  }
  if (msg?.content && typeof msg.content === 'object') {
    try {
      return JSON.stringify(msg.content);
    } catch (e) {
      return String(msg.content);
    }
  }
  return '';
}

function stripTimecodeMarkers(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\}\}/gi, '')
    .replace(/\[ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\[TC:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runDocumentAgent(context: AgentContext) {
  const { messages, uiMessages, model, userPrompt, documentContent, userId, conversationId, abortSignal } =
    context;
  let generatedDocumentContent = '';

  const safeOriginalUIMessages = (() => {
    if (Array.isArray(uiMessages) && uiMessages.length > 0) return uiMessages as any;
    // Minimal fallback shape expected by `createUIMessageStream`.
    return (Array.isArray(messages) ? messages : []).map((m: any, idx: number) => {
      const text = typeof m?.content === 'string' ? m.content : '';
      return {
        id: String(m?.id ?? `m-${idx}-${Date.now()}`),
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        parts: [{ type: 'text', text }],
        metadata: m?.metadata ?? {},
      };
    });
  })();

  const stream = createUIMessageStream({
    originalMessages: safeOriginalUIMessages,
    execute: async ({ writer }) => {
      try {
        // Use uiMessages for conversation context as they contain the original dialogue history
        generatedDocumentContent = await generateFinalDocument(
          uiMessages || [], // Use uiMessages instead of messages, with fallback
          userPrompt,
          writer,
          model,
          documentContent,
          conversationId,
          0.1,
          abortSignal ?? undefined,
        );
        const doneId = `done-${Date.now()}`;
        writer.write({ type: 'text-start', id: doneId });
        writer.write({ type: 'text-delta', id: doneId, delta: 'Протокол обследования сформирован.' });
        writer.write({ type: 'text-end', id: doneId });
      } catch (error) {
        console.error('Document generation error:', error);
        writer.write({ type: 'text-start', id: 'error' });
        writer.write({
          type: 'text-delta',
          id: 'error',
          delta: 'Произошла ошибка при формировании документа. Попробуйте снова.',
        });
        writer.write({ type: 'text-end', id: 'error' });
      }
    },
    onFinish: async ({ messages: finished }) => {
      if (userId) {
        try {
          if (conversationId) {
            await updateConversation(conversationId, finished, generatedDocumentContent);
          } else {
            await saveConversation(userId, finished, generatedDocumentContent);
          }
        } catch (e) {
          console.error('document persistence failed', e);
        }
      }
    }
  });

  const readable = stream.pipeThrough(new JsonToSseTransformStream());
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** Генерация протокола в правую панель (`data-title`, `data-documentDelta`, …). Пишет в переданный writer. */
export async function generateFinalDocument(
  uiMessages: any[], // Changed from messages to uiMessages
  userPrompt: string | null,
  dataStream: any,
  model: any,
  existingDocument?: string,
  conversationId?: string | null,
  temperature: number = 0.1,
  abortSignal?: AbortSignal,
): Promise<string> {
  const writeData = (payload: { type: string; data: any; id?: string; transient?: boolean }) => {
    dataStream.write({
      type: payload.type,
      data: payload.data,
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.transient ? { transient: payload.transient } : {}),
    });
  };

  // Извлекаем всю историю диалога (расшифровку встречи) из uiMessages
  const conversationContext = uiMessages
    .map((msg) => {
      // Extract text from uiMessages format (parts array)
      let text = '';
      if (Array.isArray(msg?.parts)) {
        text = msg.parts
          .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join(' ');
      }
      // Fallback to content if parts didn't yield text
      if (!text && typeof msg?.content === 'string') {
        text = msg.content;
      }
      
      const cleaned = stripTimecodeMarkers(text);
      return cleaned ? `${msg.role}: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Подготовка контекста существующего документа (если есть ручные правки)
  const existingDocumentContext = existingDocument && existingDocument.trim()
    ? `\n\nСУЩЕСТВУЮЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n"""\n${existingDocument}\n"""\n\n`
    : '';

  const chatDraft = buildProtocolDraftFromChat(uiMessages);
  const agreedChatContext = formatChatDraftForPrompt(chatDraft);
  if (Object.keys(chatDraft).length > 0) {
    console.log(
      `[generateFinalDocument] chat draft: topics=${chatDraft.meetingContent?.topics?.length ?? 0} summary=${chatDraft.meetingContent?.summary?.length ?? 0} approval_cust=${chatDraft.approval?.customer?.signatories?.length ?? 0}`,
    );
  }

  // Use SGR-enhanced document generation prompt
  const protocolPrompt = SGR_DOCUMENT_AGENT_PROMPT.replace('{{CONVERSATION_CONTEXT}}', conversationContext)
    .replace('{{EXISTING_DOCUMENT_CONTEXT}}', existingDocumentContext)
    .replace(
      '{{AGREED_CHAT_CONTEXT}}',
      agreedChatContext ||
        '(Отдельный блок согласованных разделов не выделен — используйте подтверждённые пользователем формулировки из истории диалога.)',
    );

  let markdownContent = '';

  try {
    const maxOutputTokens = ollamaProtocolMaxOutputTokens();
    console.log(`[generateFinalDocument] maxOutputTokens=${maxOutputTokens}`);
    const streamResult = streamObject({
      model,
      temperature,
      maxOutputTokens,
      schema: ProtocolSchema,
      prompt: protocolPrompt,
      ...(abortSignal ? { abortSignal } : {}),
    });

    let lastMarkdown = '';
    let lastTitle = '';

    for await (const partial of streamResult.partialObjectStream) {
      const safeProtocol = mergeProtocolWithChatDraft(coerceProtocolPartial(partial), chatDraft);

      let nextMarkdown = '';
      try {
        nextMarkdown = protocolToMarkdown(safeProtocol);
      } catch {
        continue;
      }

      if (!nextMarkdown || nextMarkdown === lastMarkdown) continue;

      if (safeProtocol.protocolNumber) {
        const nextTitle = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${safeProtocol.protocolNumber}`.trim();
        if (nextTitle && nextTitle !== lastTitle) {
          writeData({ type: 'data-title', data: nextTitle, transient: true });
          lastTitle = nextTitle;
        }
      }

      writeData({ type: 'data-clear', data: null, transient: true });
      writeData({ type: 'data-documentDelta', data: nextMarkdown, transient: true });

      lastMarkdown = nextMarkdown;
      markdownContent = nextMarkdown;
    }

    let validated: Protocol;
    let rawFinal: unknown;
    try {
      rawFinal = await streamResult.object;
    } catch (objErr) {
      const fallbackText = extractNoObjectGeneratedText(objErr);
      const recovered = fallbackText ? parseLooseJsonObject(fallbackText) : null;
      if (!recovered) throw objErr;
      rawFinal = recovered;
      console.warn('[generateFinalDocument] recovered JSON from fenced / non-schema LLM output');
    }
    try {
      validated = parseProtocolStrict(rawFinal);
    } catch (validationErr) {
      console.error('[generateFinalDocument] Protocol schema validation failed:', validationErr);
      throw new Error(
        'Итоговый протокол не прошёл проверку структуры (protocol-schema). Сформируйте документ повторно или дополните расшифровку.',
      );
    }

    validated = mergeProtocolWithChatDraft(validated, chatDraft);

    const finalMarkdown = protocolToMarkdown(validated);
    markdownContent = finalMarkdown;
    writeData({ type: 'data-clear', data: null, transient: true });
    writeData({ type: 'data-documentDelta', data: finalMarkdown, transient: true });

    writeData({ type: 'data-finish', data: null, transient: true });

    const docxBuffer = await generateProtocolDocx(validated);
    const base64Docx = docxBuffer.toString('base64');
    writeData({
      type: 'data-docx',
      data: {
        content: base64Docx,
        filename: `Протокол_обследования_${validated.protocolNumber.replace(/[^0-9]/g, '')}_${validated.meetingDate.replace(/\./g, '-')}.docx`,
      },
    });
  } catch (error) {
    console.error('Protocol generation error:', error);
    throw error;
  }

  return markdownContent;
}

/** Проверяет, что название организации — реальное имя, а не заглушка или мусор из LLM. */
function isValidOrgDisplayName(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  if (/^[-–—\s.]+$/.test(s)) return false;         // только дефисы/тире/точки
  if (/^(заказчик|исполнитель)$/i.test(s)) return false;
  if (s.length > 100) return false;                 // слишком длинно — попал контент встречи
  return true;
}

function protocolToMarkdown(protocol: Protocol): string {
  const normalizedNumber = String(protocol.protocolNumber || '').trim().startsWith('№')
    ? String(protocol.protocolNumber).trim()
    : `№${String(protocol.protocolNumber || '').trim()}`;

  let md = `ПРОТОКОЛ ${normalizedNumber} ОТ ${protocol.meetingDate}\n\n`;

  const title = cleanProtocolText(protocol.protocolTitle);
  if (title) md += `**${title}**\n\n`;

  md += `${formatContractBlock(protocol)}\n\n`;
  if (protocol.contractSubject) {
    md += `Тема договора: ${cleanProtocolText(protocol.contractSubject)}\n\n`;
  }

  md += '---\n\n';

  // 1. Дата собрания
  md += formatProtocolSectionHeading(1, `Дата собрания: ${protocol.meetingDate}`);

  // 2. Повестка
  md += formatProtocolSectionHeading(2, 'Повестка:');
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item, i) => {
      md += `${i + 1}) ${cleanProtocolText(item)};\n`;
    });
  }
  md += '\n\n';

  // 3. Участники
  md += formatProtocolSectionHeading(3, 'Участники:');

  const custOrg = protocol.participants.customer.organizationName.trim();
  md += `**Заказчик${isValidOrgDisplayName(custOrg) ? ` — ${custOrg}` : ''}**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.customer.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => { md += `| ${p.fullName} | ${p.position} |\n`; });

  md += '\n\n';

  const execOrg = protocol.participants.executor.organizationName.trim();
  md += `**Исполнитель${isValidOrgDisplayName(execOrg) ? ` — ${execOrg}` : ''}**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.executor.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => { md += `| ${p.fullName} | ${p.position} |\n`; });

  md += '\n\n';

  // 4. Содержание встречи
  md += formatProtocolSectionHeading(4, 'Содержание встречи:');
  protocol.meetingContent.topics.forEach((topic, i) => {
    md += `**${i + 1}) ${cleanProtocolText(topic.title)}**\n\n`;
    const listened = cleanProtocolText(topic.listened);
    const discussed = cleanProtocolText(topic.discussed);
    const decided = cleanProtocolText(topic.decided);
    if (listened) md += `**Слушали:** ${listened}\n\n`;
    if (discussed) md += `**Обсудили:** ${discussed}\n\n`;
    if (decided) md += `**Решили:** ${decided}\n\n`;
  });

  if (protocol.meetingContent.summary.length > 0) {
    md += '**Резюме:**\n\n';
    md += '| Обсуждаемые вопросы | Принятые решения |\n';
    md += '| --- | --- |\n';
    protocol.meetingContent.summary.forEach((row) => {
      const q = cleanProtocolText(row.question);
      const d = formatSummaryDecisionForMarkdown(row.decision);
      if (q || d) md += `| ${q} | ${d} |\n`;
    });
    md += '\n';
  }

  md += '\n\n';

  // 5. Согласовано — двухколоночная таблица
  md += formatProtocolSectionHeading(5, 'Согласовано:');

  const approval = resolveApprovalForDocument(protocol);
  const formatApprOrg = (org: string) => {
    const t = org.trim();
    if (!t || /^(заказчик|исполнитель)$/i.test(t)) return 'не указано в расшифровке';
    if (/^ООО\s/i.test(t)) return `${t}:`;
    const inner = t.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').replace(/^ООО\s+/, '').trim();
    return `ООО «${inner}»:`;
  };

  const custSigs = approval.customer.signatories;
  const execSigs = approval.executor.signatories;
  const sigLen = Math.max(custSigs.length, execSigs.length, 1);

  md += `| **Со стороны Заказчика** | **Со стороны Исполнителя** |\n`;
  md += `| --- | --- |\n`;
  md += `| ${formatApprOrg(approval.customer.organization)} | ${formatApprOrg(approval.executor.organization)} |\n`;

  for (let i = 0; i < sigLen; i++) {
    const cust = custSigs[i] ? `${custSigs[i].trim()} /______________` : '______________________';
    const exec = execSigs[i] ? `${execSigs[i].trim()} /______________` : '______________________';
    md += `| ${cust} | ${exec} |\n`;
  }
  md += '\n';

  return md;
}
