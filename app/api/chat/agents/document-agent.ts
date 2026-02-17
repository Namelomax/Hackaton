import { createUIMessageStream, JsonToSseTransformStream, streamObject } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import { ProtocolSchema, type Protocol } from '@/lib/schemas/protocol-schema';
import { generateProtocolDocx } from '@/lib/docx-generator';

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

function coerceProtocol(partial: Partial<Protocol>): Protocol {
  const toString = (value: any) => (value == null ? '' : String(value));
  const toArray = <T>(value: any): T[] => (Array.isArray(value) ? value : []);
  const toPeople = (value: any) =>
    toArray(value).map((p: any) => ({
      fullName: toString(p?.fullName || p?.name),
      position: toString(p?.position || p?.role),
    }));

  return {
    protocolNumber: toString(partial.protocolNumber),
    meetingDate: toString(partial.meetingDate),
    agenda: {
      title: toString(partial.agenda?.title),
      items: toArray<string>(partial.agenda?.items).map(toString),
    },
    participants: {
      customer: {
        organizationName: toString(partial.participants?.customer?.organizationName),
        people: toPeople(partial.participants?.customer?.people),
      },
      executor: {
        organizationName: toString(partial.participants?.executor?.organizationName),
        people: toPeople(partial.participants?.executor?.people),
      },
    },
    termsAndDefinitions: toArray(partial.termsAndDefinitions).map((item: any) => ({
      term: toString(item?.term),
      definition: toString(item?.definition),
    })),
    abbreviations: toArray(partial.abbreviations).map((item: any) => ({
      abbreviation: toString(item?.abbreviation),
      fullForm: toString(item?.fullForm),
    })),
    meetingContent: {
      introduction: toString(partial.meetingContent?.introduction || ''),
      topics: toArray(partial.meetingContent?.topics).map((topic: any) => ({
        title: toString(topic?.title),
        content: toString(topic?.content),
        subtopics: toArray(topic?.subtopics).map((sub: any) => ({
          title: toString(sub?.title || ''),
          content: toString(sub?.content),
        })),
      })),
      migrationFeatures: toArray(partial.meetingContent?.migrationFeatures).map((feat: any) => ({
        tab: toString(feat?.tab),
        features: toString(feat?.features),
      })),
    },
    questionsAndAnswers: toArray(partial.questionsAndAnswers).map((qa: any) => ({
      question: toString(qa?.question),
      answer: toString(qa?.answer),
    })),
    decisions: toArray(partial.decisions).map((decision: any) => ({
      decision: toString(decision?.decision),
      responsible: toString(decision?.responsible),
    })),
    openQuestions: toArray<string>(partial.openQuestions).map(toString),
    approval: {
      executorSignature: {
        organization: toString(partial.approval?.executorSignature?.organization),
        representative: toString(partial.approval?.executorSignature?.representative),
      },
      customerSignature: {
        organization: toString(partial.approval?.customerSignature?.organization),
        representative: toString(partial.approval?.customerSignature?.representative),
      },
    },
  };
}

function stripTimecodeMarkers(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\}\}/gi, '')
    .replace(/\[TC:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runDocumentAgent(context: AgentContext) {
  const { messages, uiMessages, model, userPrompt, documentContent, userId, conversationId } = context;
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
        generatedDocumentContent = await generateFinalDocument(
          messages,
          userPrompt,
          writer,
          model,
          documentContent,
          conversationId
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

async function generateFinalDocument(
  messages: any[], 
  userPrompt: string | null,
  dataStream: any,
  model: any,
  existingDocument?: string,
  conversationId?: string | null,
  temperature: number = 0.1,
): Promise<string> {
  const writeData = (payload: { type: string; data: any; id?: string; transient?: boolean }) => {
    dataStream.write({
      type: payload.type,
      data: payload.data,
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.transient ? { transient: payload.transient } : {}),
    });
  };


  // Извлекаем всю историю диалога (расшифровку встречи)
  const conversationContext = messages
    .map((msg) => {
      const text = extractMessageText(msg);
      const cleaned = stripTimecodeMarkers(text);
      return cleaned ? `${msg.role}: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');

  const progressId = `protocol-${crypto.randomUUID()}`;
  dataStream.write({ type: 'text-start', id: progressId });

  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '📝 Формирование протокола обследования\n',
  });

  const protocolPrompt = `Ты специалист по составлению протоколов обследования.

ТВОЯ ЗАДАЧА:
Создать структурированный протокол обследования на основе диалога между агентом и клиентом.

СТРОГИЕ ТРЕБОВАНИЯ:
1. Протокол ДОЛЖЕН содержать ВСЕ 10 разделов
2. НЕ ИМПРОВИЗИРУЙ - используй ТОЛЬКО факты из диалога
3. Если информация отсутствует, укажи это явно (например, "Информация не предоставлена")
4. Даты должны быть в формате ДД.ММ.ГГГГ
5. Все участники должны быть указаны с полными ФИО и должностями
6. Таблицы должны быть заполнены корректно
7. Содержание встречи заполняй подробно и структурированно
8. Вопросы и ответы должны быть четко разделены
9. Решения ДОЛЖНЫ иметь указание на ответственного
10. НЕ включай в протокол гипотетические/примерные формулировки ("например", "может быть", "допустим", "возможно"). Такие фразы не считаются фактом.
11. Раздел "Особенности миграции" заполняй только если это прямо подтвержденный факт, а не пример или гипотеза.

СТРУКТУРА ПРОТОКОЛА:
1. Номер протокола и дата встречи
2. Повестка (тема + пункты)
3. Участники (таблицы со стороны Заказчика и Исполнителя)
4. Термины и определения
5. Сокращения и обозначения
6. Содержание встречи (обсуждаемые вопросы, темы)
7. Вопросы и ответы
8. Решения с ответственными
9. Открытые вопросы
10. Согласовано (подписи)

ПОЛНЫЙ ДИАЛОГ:
"""
${conversationContext}
"""

Сформируй корректный протокол обследования в соответствии со схемой.`;

  let protocol: Protocol | null = null;
  let markdownContent = '';

  try {
    const { partialObjectStream } = streamObject({
      model,
      temperature,
      schema: ProtocolSchema,
      prompt: protocolPrompt,
    });

    let lastMarkdown = '';
    let lastTitle = '';

    for await (const partial of partialObjectStream) {
      const safeProtocol = coerceProtocol(partial as Partial<Protocol>);
      protocol = safeProtocol;

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

    writeData({ type: 'data-finish', data: null, transient: true });

    if (!protocol) {
      throw new Error('Failed to generate protocol');
    }

    const docxBuffer = await generateProtocolDocx(protocol);
    const base64Docx = docxBuffer.toString('base64');
    writeData({
      type: 'data-docx',
      data: {
        content: base64Docx,
        filename: `Протокол_обследования_${protocol.protocolNumber.replace(/[^0-9]/g, '')}_${protocol.meetingDate.replace(/\./g, '-')}.docx`,
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

  md += `1.\tДата встречи: ${protocol.meetingDate}\n`;

  md += `2.\tПовестка: ${protocol.agenda.title}\n`;
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item) => {
      md += `•\t${item}\n`;
    });
  }

  md += '\n';

  md += `3.\tУчастники:\n`;
  md += `Со стороны Заказчика ${protocol.participants.customer.organizationName}:\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.customer.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n';
  md += `Со стороны Исполнителя ${protocol.participants.executor.organizationName}:\n`;
  md += '| ФИО | Должность/роль |\n';
  md += '| --- | --- |\n';
  protocol.participants.executor.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n';

  md += `4.\tТермины и определения:\n`;
  protocol.termsAndDefinitions.forEach((term) => {
    md += `•\t${term.term} – ${term.definition}\n`;
  });

  md += '\n';

  md += `5.\tСокращения и обозначения:\n`;
  protocol.abbreviations.forEach((abbr) => {
    md += `•\t${abbr.abbreviation} – ${abbr.fullForm}\n`;
  });

  md += '\n';

  md += `6.\tСодержание встречи:\n`;
  md += 'В ходе встречи обсуждались следующие вопросы:\n';
  if (protocol.meetingContent.introduction) {
    md += `${protocol.meetingContent.introduction}\n`;
  }
  protocol.meetingContent.topics.forEach((topic) => {
    md += `${topic.title}\n`;
    md += `${topic.content}\n`;
    if (topic.subtopics && topic.subtopics.length > 0) {
      topic.subtopics.forEach((sub) => {
        if (sub.title) {
          md += `${sub.title}\n`;
        }
        md += `${sub.content}\n`;
      });
    }
  });
  if (protocol.meetingContent.migrationFeatures && protocol.meetingContent.migrationFeatures.length > 0) {
    md += '| Вкладка | Особенности |\n';
    md += '| --- | --- |\n';
    protocol.meetingContent.migrationFeatures.forEach((feat) => {
      md += `| ${feat.tab} | ${feat.features} |\n`;
    });
  }

  md += '\n';

  md += `7.\tВопросы:\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `${i + 1}.\t${qa.question}\n`;
  });
  md += '\nОтветы:\n';
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `${i + 1}.\t${qa.answer}\n`;
  });

  md += '\n';

  md += `8.\tРешения:\n`;
  protocol.decisions.forEach((decision, i) => {
    md += `${i + 1}.\t${decision.decision}\n`;
    md += `Ответственный: ${decision.responsible}\n`;
  });

  md += '\n';

  md += `9.\tОткрытые вопросы:\n`;
  protocol.openQuestions.forEach((q, i) => {
    md += `${i + 1}.\t${q}\n`;
  });

  md += '\n';

  md += '10.\tСогласовано:\n\n';
  md += '| Со стороны Исполнителя | Со стороны Заказчика |\n';
  md += '| --- | --- |\n';
  md += `| ${protocol.approval.executorSignature.organization} | ${protocol.approval.customerSignature.organization} |\n`;
  md += `| ${protocol.approval.executorSignature.representative} /______________ | ${protocol.approval.customerSignature.representative} /______________ |\n`;

  return md;
}
