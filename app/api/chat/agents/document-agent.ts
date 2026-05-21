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
  isChatDraftComplete,
  buildProtocolFromChatOnly,
} from '@/lib/protocol-chat-extract';
import { finalizeProtocol } from '@/lib/protocol-sanitize';
import { streamProtocolToPanel, emitDocumentDelta } from '@/lib/protocol-document-stream';
import {
  cleanProtocolText,
  formatPlainSectionLine,
  formatAgendaItem,
  formatMeetingQuestionItem,
  formatDecidedForOutput,
  isValidParticipantRow,
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
  const chatOnlyProtocol = buildProtocolFromChatOnly(uiMessages);
  let markdownContent = '';
  if (Object.keys(chatDraft).length > 0) {
    console.log(
      `[generateFinalDocument] chat draft: header=${Boolean(chatDraft.protocolTitle)} agenda=${chatDraft.agendaItems?.length ?? 0} participants=${(chatDraft.participants?.customer.people.length ?? 0) + (chatDraft.participants?.executor.people.length ?? 0)} questions=${chatDraft.meetingQuestions?.length ?? 0} resume=${chatDraft.resume?.length ?? 0} complete=${isChatDraftComplete(chatDraft)}`,
    );
  }

  if (chatOnlyProtocol) {
    const validated = chatOnlyProtocol;
    const finalMarkdown = protocolToMarkdown(validated);
    markdownContent = finalMarkdown;
    const docTitle = `ПРОТОКОЛ № ${validated.protocolNumber}`.trim();
    await streamProtocolToPanel(finalMarkdown, writeData, { title: docTitle, chunkDelayMs: 32 });
    const docxBuffer = await generateProtocolDocx(validated);
    writeData({
      type: 'data-docx',
      data: {
        content: docxBuffer.toString('base64'),
        filename: `Протокол_${validated.protocolNumber.replace(/[^0-9]/g, '')}_${validated.protocolDate.replace(/\./g, '-')}.docx`,
      },
    });
    return markdownContent;
  }

  // Use SGR-enhanced document generation prompt
  const protocolPrompt = SGR_DOCUMENT_AGENT_PROMPT.replace('{{CONVERSATION_CONTEXT}}', conversationContext)
    .replace('{{EXISTING_DOCUMENT_CONTEXT}}', existingDocumentContext)
    .replace(
      '{{AGREED_CHAT_CONTEXT}}',
      agreedChatContext ||
        '(Отдельный блок согласованных разделов не выделен — используйте подтверждённые пользователем формулировки из истории диалога.)',
    );

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
    let panelCleared = false;

    for await (const partial of streamResult.partialObjectStream) {
      const safeProtocol = finalizeProtocol(
        mergeProtocolWithChatDraft(coerceProtocolPartial(partial), chatDraft),
      );

      let nextMarkdown = '';
      try {
        nextMarkdown = protocolToMarkdown(safeProtocol);
      } catch {
        continue;
      }

      if (!nextMarkdown || nextMarkdown === lastMarkdown) continue;

      if (!panelCleared) {
        writeData({ type: 'data-clear', data: null, transient: true });
        panelCleared = true;
      }

      if (safeProtocol.protocolNumber) {
        const nextTitle = `ПРОТОКОЛ № ${safeProtocol.protocolNumber}`.trim();
        if (nextTitle && nextTitle !== lastTitle) {
          writeData({ type: 'data-title', data: nextTitle, transient: true });
          lastTitle = nextTitle;
        }
      }

      emitDocumentDelta(writeData, nextMarkdown, true);

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

    validated = finalizeProtocol(mergeProtocolWithChatDraft(validated, chatDraft));

    const finalMarkdown = protocolToMarkdown(validated);
    markdownContent = finalMarkdown;

    if (!panelCleared) {
      await streamProtocolToPanel(finalMarkdown, writeData, {
        title: `ПРОТОКОЛ № ${validated.protocolNumber}`.trim(),
        chunkDelayMs: 0,
      });
    } else {
      emitDocumentDelta(writeData, finalMarkdown, true);
      writeData({ type: 'data-finish', data: null, transient: true });
    }

    const docxBuffer = await generateProtocolDocx(validated);
    const base64Docx = docxBuffer.toString('base64');
    writeData({
      type: 'data-docx',
      data: {
        content: base64Docx,
        filename: `Протокол_${validated.protocolNumber.replace(/[^0-9]/g, '')}_${validated.protocolDate.replace(/\./g, '-')}.docx`,
      },
    });
  } catch (error) {
    console.error('Protocol generation error:', error);
    throw error;
  }

  return markdownContent;
}

function protocolToMarkdown(protocol: Protocol): string {
  const numRaw = String(protocol.protocolNumber || '').trim().replace(/^№\s*/i, '');
  const num = numRaw || '—';
  const protoDate = protocol.protocolDate.trim() || '—';

  let md = `ПРОТОКОЛ №  ${num}  ОТ  ${protoDate}\n`;
  md += `${cleanProtocolText(protocol.protocolTitle) || '—'}\n`;
  const contractNum = protocol.contractNumber.trim();
  const contractDate = protocol.contractDate.trim();
  const contractMissing =
    !contractNum || /не\s+указан/i.test(contractNum) || /не\s+указан/i.test(contractDate);
  if (!contractMissing) {
    md += `Договор №${contractNum.replace(/^№/, '')}${contractDate ? ` от ${contractDate}` : ''}\n`;
  }
  if (protocol.contractTopic.trim()) {
    md += `Тема договора: ${cleanProtocolText(protocol.contractTopic)}\n`;
  }
  md += '\n';

  md += formatPlainSectionLine(1, `Дата собрания: ${protocol.assemblyDate || protoDate}`);

  md += formatPlainSectionLine(2, 'Повестка:');
  protocol.agendaItems.forEach((item, i) => {
    md += formatAgendaItem(i, item);
  });
  md += '\n';

  md += formatPlainSectionLine(3, 'Участники:');
  md += 'Заказчик\n';
  md += 'ФИО\tДолжность\n';
  protocol.participants.customer.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => {
      md += `${p.fullName}\t${p.position}\n`;
    });
  if (!protocol.participants.customer.people.some((p) => p.fullName.trim())) {
    md += '\t\n';
  }
  md += 'Исполнитель\n';
  md += 'ФИО\tДолжность\n';
  protocol.participants.executor.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => {
      md += `${p.fullName}\t${p.position}\n`;
    });
  md += '\n';

  md += formatPlainSectionLine(4, 'Содержание встречи:');
  protocol.meetingQuestions.forEach((q, i) => {
    const question = cleanProtocolText(q.question);
    if (!question) return;
    md += formatMeetingQuestionItem(i, question);
    if (q.listened.trim()) md += `Слушали: ${cleanProtocolText(q.listened)}\n`;
    if (q.discussed.trim()) md += `Обсудили: ${cleanProtocolText(q.discussed)}\n`;
    if (q.decided.trim()) md += `Решили:\n${formatDecidedForOutput(q.decided)}\n`;
    md += '\n';
  });

  if (protocol.resume.length > 0) {
    md += 'Резюме:\n';
    md += 'Обсуждаемые вопросы\tПринятые решения\tСрок\tОтветственный\n';
    protocol.resume.forEach((row) => {
      md += `${cleanProtocolText(row.discussedQuestion)}\t${cleanProtocolText(row.decision)}\t${cleanProtocolText(row.deadline ?? '—')}\t${cleanProtocolText(row.responsible ?? '—')}\n`;
    });
    md += '\n';
  }

  md += formatPlainSectionLine(5, 'Согласовано:');
  md += 'Со стороны Заказчика\tСо стороны Исполнителя\n';
  md += `${protocol.approval.customer.organizationName}:\t${protocol.approval.executor.organizationName}:\n`;

  const custSigs =
    protocol.approval.customer.signatories.filter(Boolean).length > 0
      ? protocol.approval.customer.signatories
      : protocol.participants.customer.people.map((p) => p.fullName).filter(Boolean);
  const execSigs =
    protocol.approval.executor.signatories.filter(Boolean).length > 0
      ? protocol.approval.executor.signatories
      : protocol.participants.executor.people.map((p) => p.fullName).filter(Boolean);

  const maxSigs = Math.max(custSigs.length, execSigs.length, 1);
  for (let i = 0; i < maxSigs; i++) {
    const cust = custSigs[i]?.trim() || '';
    const exec = execSigs[i]?.trim() || '';
    md += `${cust || '________________'}\t\t${exec || '________________'}\t\t\n`;
  }
  md += '\n';

  return md;
}
