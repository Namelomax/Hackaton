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
import { verifyProtocolSections } from '@/lib/protocol-verify';
import { SGR_DOCUMENT_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { PROTOCOL_REGULATION } from '@/lib/prompts/regulation';
import { ollamaProtocolMaxOutputTokens } from '@/lib/ollama-limits';
import {
  buildProtocolDraftFromChat,
  formatChatDraftForPrompt,
  extractLatestUserCorrections,
  mergeProtocolWithChatDraft,
} from '@/lib/protocol-chat-extract';
import { applyGlossaryToProtocol } from '@/lib/prompts/glossary';
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

  // Извлекаем всю историю диалога (расшифровку встречи) из uiMessages.
  // ВАЖНО: текст загруженных файлов (расшифровка) лежит НЕ в content, а в
  // metadata.hiddenTexts (см. route.ts «3. Process Attachments»). Раньше агент
  // документа его не читал — поэтому в документ не попадала расшифровка и
  // разделы 2/4 оказывались пустыми или выдуманными. Теперь подмешиваем её явно.
  const MAX_TRANSCRIPT_CHARS = Number(process.env.DOC_MAX_TRANSCRIPT_CHARS ?? 60000);
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

      // Текст вложений (расшифровка встречи) из metadata.hiddenTexts
      const hiddenTexts: string[] = Array.isArray((msg as any)?.metadata?.hiddenTexts)
        ? (msg as any).metadata.hiddenTexts.filter(
            (h: unknown) => typeof h === 'string' && h.trim().length > 0,
          )
        : [];
      let transcriptBlock = '';
      if (hiddenTexts.length > 0) {
        let joined = hiddenTexts.join('\n\n');
        if (joined.length > MAX_TRANSCRIPT_CHARS) {
          joined =
            joined.slice(0, MAX_TRANSCRIPT_CHARS) +
            '\n…(расшифровка обрезана по лимиту DOC_MAX_TRANSCRIPT_CHARS)…';
        }
        transcriptBlock = `\n[РАСШИФРОВКА ВСТРЕЧИ — первоисточник фактов для разделов 2 и 4]:\n${joined}`;
      }

      const combined = [text, transcriptBlock].filter(Boolean).join('\n');
      const cleaned = stripTimecodeMarkers(combined);
      return cleaned ? `${msg.role}: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Подготовка контекста существующего документа (если есть ручные правки)
  const existingDocumentContext = existingDocument && existingDocument.trim()
    ? `\n\nСУЩЕСТВУЮЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n"""\n${existingDocument}\n"""\n\n`
    : '';

  const chatDraft = buildProtocolDraftFromChat(uiMessages);
  const userCorrections = extractLatestUserCorrections(uiMessages);
  const agreedChatContext = formatChatDraftForPrompt(chatDraft, userCorrections);
  if (Object.keys(chatDraft).length > 0 || userCorrections.length > 0) {
    console.log(
      `[generateFinalDocument] chat draft: agenda=${chatDraft.agenda?.items?.length ?? 0} topics=${chatDraft.meetingContent?.topics?.length ?? 0} summary=${chatDraft.meetingContent?.summary?.length ?? 0} approval_cust=${chatDraft.approval?.customer?.signatories?.length ?? 0} corrections=${userCorrections.length}`,
    );
  }

  // Use SGR-enhanced document generation prompt
  const protocolPrompt = SGR_DOCUMENT_AGENT_PROMPT
    .replace('{{REGULATION}}', PROTOCOL_REGULATION)
    .replace('{{CONVERSATION_CONTEXT}}', conversationContext)
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
    // Track exactly what has been sent to the frontend to compute true deltas.
    // Clear once upfront so the panel is blank before streaming begins.
    writeData({ type: 'data-clear', data: null, transient: true });
    let sentContent = '';

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

      // Send only the new delta so the frontend can append without clearing.
      // If content was reorganized (doesn't start with what we sent), do a full reset.
      if (nextMarkdown.startsWith(sentContent)) {
        const delta = nextMarkdown.slice(sentContent.length);
        if (delta) {
          writeData({ type: 'data-documentDelta', data: delta, transient: true });
          sentContent = nextMarkdown;
        }
      } else {
        writeData({ type: 'data-clear', data: null, transient: true });
        writeData({ type: 'data-documentDelta', data: nextMarkdown, transient: true });
        sentContent = nextMarkdown;
      }

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

    // Страховка от пустых разделов: если модель вернула пустую повестку/участников/
    // содержание/подписи, добиваем их согласованными в чате блоками (ранее эта
    // функция существовала, но не вызывалась — пустые разделы уходили в документ).
    validated = mergeProtocolWithChatDraft(validated, chatDraft);

    // Детерминированная зачистка жаргона/разговорных слов перед выводом в документ.
    // Не трогает ФИО и названия организаций — только содержательные поля.
    validated = applyGlossaryToProtocol(validated);

    const finalMarkdown = protocolToMarkdown(validated);
    markdownContent = finalMarkdown;
    // Append only what hasn't been sent yet; full reset if final was restructured.
    if (finalMarkdown !== sentContent) {
      if (finalMarkdown.startsWith(sentContent)) {
        const remaining = finalMarkdown.slice(sentContent.length);
        if (remaining) writeData({ type: 'data-documentDelta', data: remaining, transient: true });
      } else {
        writeData({ type: 'data-clear', data: null, transient: true });
        writeData({ type: 'data-documentDelta', data: finalMarkdown, transient: true });
      }
    }

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

    // Чанкованная верификация — включается через ENABLE_PROTOCOL_VERIFY=true
    if (process.env.ENABLE_PROTOCOL_VERIFY === 'true') {
      try {
        console.log('[verify] Запуск проверки протокола по секциям...');
        const checks = await verifyProtocolSections(validated, conversationContext, model, abortSignal ?? undefined);
        const found = checks.filter((c) => c.hasIssues);
        if (found.length > 0) {
          const warnText =
            `⚠️ Автопроверка нашла возможные несоответствия:\n` +
            found.map((f) => `• ${f.section}: ${f.issues}`).join('\n');
          const warnId = `verify-${Date.now()}`;
          dataStream.write({ type: 'text-start', id: warnId });
          dataStream.write({ type: 'text-delta', id: warnId, delta: warnText });
          dataStream.write({ type: 'text-end', id: warnId });
          console.log(`[verify] Найдено проблем: ${found.length}`);
        } else {
          console.log('[verify] Все секции OK');
        }
      } catch (verifyErr) {
        console.warn('[verify] Проверка не выполнена:', verifyErr);
      }
    }
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

/** Converts a multiline string to a markdown bullet list. Single-line text is returned as-is. */
function formatMultilineField(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return text;
  return lines.map((l) => `- ${l}`).join('\n');
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
    if (discussed) md += `**Обсудили:**\n\n${formatMultilineField(discussed)}\n\n`;
    if (decided) md += `**Решили:**\n\n${formatMultilineField(decided)}\n\n`;
  });

  if (protocol.meetingContent.summary.length > 0) {
    md += '**Резюме:**\n\n';
    md += '| **Обсуждаемые вопросы** | **Принятые решения** |\n';
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
    // If value was wrapped in ООО «...», keep that form
    const inner = t.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').trim();
    if (inner !== t) return `ООО «${inner}»:`;
    // Non-ООО entity (hackathon teams, consortia, etc.) — use as-is
    return `${t}:`;
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
