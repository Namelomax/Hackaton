import { createUIMessageStream, JsonToSseTransformStream, streamObject } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import {
  ProtocolSchema,
  coerceProtocolPartial,
  parseProtocolStrict,
  type Protocol,
} from '@/lib/schemas/protocol-schema';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { SGR_DOCUMENT_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { ollamaProtocolMaxOutputTokens } from '@/lib/ollama-limits';

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

  const progressId = `protocol-${crypto.randomUUID()}`;
  dataStream.write({ type: 'text-start', id: progressId });

  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '📝 Формирование протокола обследования\n',
  });

  // Use SGR-enhanced document generation prompt
  const protocolPrompt = SGR_DOCUMENT_AGENT_PROMPT
    .replace('{{CONVERSATION_CONTEXT}}', conversationContext)
    .replace('{{EXISTING_DOCUMENT_CONTEXT}}', existingDocumentContext);

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
      const safeProtocol = coerceProtocolPartial(partial);

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
    try {
      validated = parseProtocolStrict(await streamResult.object);
    } catch (validationErr) {
      console.error('[generateFinalDocument] Protocol schema validation failed:', validationErr);
      throw new Error(
        'Итоговый протокол не прошёл проверку структуры (protocol-schema). Сформируйте документ повторно или дополните расшифровку.',
      );
    }

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
    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '❌ Ошибка при формировании протокола. Проверьте полноту данных в расшифровке.\n',
    });
    dataStream.write({ type: 'text-end', id: progressId });
    throw error;
  }

  dataStream.write({ type: 'text-end', id: progressId });
  return markdownContent;
}

function protocolToMarkdown(protocol: Protocol): string {
  const normalizedNumber = String(protocol.protocolNumber || '').trim().startsWith('№')
    ? String(protocol.protocolNumber).trim()
    : `№${String(protocol.protocolNumber || '').trim()}`;
  let md = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${normalizedNumber}\n\n`;

  md += `1.\tДата встречи: ${protocol.meetingDate}\n\n`;

  md += `2.\tПовестка: ${protocol.agenda.title}\n`;
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item) => {
      md += `- ${item}\n`;
    });
  }
  md += '\n\n';

  md += `3.\tУчастники:\n\n`;
  md += `**Со стороны Заказчика ${protocol.participants.customer.organizationName}:**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.customer.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n\n';
  md += `**Со стороны Исполнителя ${protocol.participants.executor.organizationName}:**\n\n`;
  md += '| ФИО | Должность/роль |\n';
  md += '| --- | --- |\n';
  protocol.participants.executor.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n\n';

  md += `4.\tТермины и определения:\n\n`;
  protocol.termsAndDefinitions.forEach((term) => {
    md += `- ${term.term} – ${term.definition}\n`;
  });

  md += '\n\n';

  md += `5.\tСокращения и обозначения:\n\n`;
  protocol.abbreviations.forEach((abbr) => {
    md += `- ${abbr.abbreviation} – ${abbr.fullForm}\n`;
  });

  md += '\n\n';

  md += `6.\tСодержание встречи:\n\n`;
  md += 'В ходе встречи обсуждались следующие вопросы:\n\n';
  if (protocol.meetingContent.introduction) {
    md += `${protocol.meetingContent.introduction}\n\n`;
  }
  protocol.meetingContent.topics.forEach((topic) => {
    md += `- ${topic.title}\n`;
    md += `  ${topic.content}\n`;
    if (topic.subtopics && topic.subtopics.length > 0) {
      topic.subtopics.forEach((sub) => {
        if (sub.title) {
          md += `  - ${sub.title}\n`;
        }
        md += `    ${sub.content}\n`;
      });
    }
  });
  md += '\n\n';
  if (protocol.meetingContent.migrationFeatures && protocol.meetingContent.migrationFeatures.length > 0) {
    md += '| Вкладка | Особенности |\n';
    md += '| --- | --- |\n';
    protocol.meetingContent.migrationFeatures.forEach((feat) => {
      md += `| ${feat.tab} | ${feat.features} |\n`;
    });
    md += '\n';
  }

  md += '\n\n';

  md += `7.\tВопросы:\n\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `- ${i + 1}. ${qa.question}\n`;
  });

  // 3 пустые строки для разрыва между списками
  md += '\n\n\n';
  md += `**Ответы**:\n\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `- ${i + 1}. ${qa.answer}\n`;
  });

  md += '\n\n\n';

  md += `8.\tРешения:\n\n`;
  protocol.decisions.forEach((decision, i) => {
    md += `- ${i + 1}. ${decision.decision}\n`;
    md += `  Ответственный: ${decision.responsible}\n`;
  });

  md += '\n\n\n';

  md += `9.\tОткрытые вопросы:\n\n`;
  protocol.openQuestions.forEach((q, i) => {
    md += `- ${i + 1}. ${q}\n`;
  });

  md += '\n\n\n';

  md += '10.\tСогласовано:\n\n';
  md += '| Со стороны Исполнителя | Со стороны Заказчика |\n';
  md += '| --- | --- |\n';
  md += `| ${protocol.approval.executorSignature.organization} | ${protocol.approval.customerSignature.organization} |\n`;
  md += `| ${protocol.approval.executorSignature.representative} /______________ | ${protocol.approval.customerSignature.representative} /______________ |\n`;
  md += '\n';

  return md;
}
