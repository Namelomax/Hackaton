import { streamText, createUIMessageStream, JsonToSseTransformStream, generateObject } from 'ai';
import { z } from 'zod';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import { ProtocolSchema, TranscriptAnalysisSchema, type Protocol, type TranscriptAnalysis } from '@/lib/schemas/protocol-schema';
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
          documentContent
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
  temperature: number = 0.1,
): Promise<string> {
  const writeData = (payload: { type: string; data: any }) => {
    dataStream.write({ type: payload.type, data: payload.data });
  };


  // Извлекаем всю историю диалога (расшифровку встречи)
  const conversationContext = messages
    .map((msg) => {
      const text = extractMessageText(msg);
      return text ? `${msg.role}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');

  const progressId = `protocol-${crypto.randomUUID()}`;
  dataStream.write({ type: 'text-start', id: progressId });
  
  // Шаг 1: Анализ расшифровки на противоречия и недосказанности
  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '🔍 Шаг 1/2: Анализ расшифровки на противоречия и недосказанности\n',
  });

  const analysisPrompt = `Ты аналитик, проверяющий расшифровку встречи с заказчиком.

ТВОЯ ЗАДАЧА:
1. Проверить расшифровку на ПРОТИВОРЕЧИЯ (взаимоисключающие утверждения, несоответствия)
2. Найти НЕДОСКАЗАННОСТИ (неясные формулировки, недостающие детали, неполные ответы)
3. Определить КРИТИЧЕСКИ ВАЖНУЮ недостающую информацию для протокола обследования

РАСШИФРОВКА ВСТРЕЧИ:
"""
${conversationContext}
"""

Проанализируй текст и верни структурированный анализ.`;

  let analysis: TranscriptAnalysis | undefined;
  let analysisStreamed = false;
  const analysisStreamPrompt = `Сделай краткий, но конкретный анализ расшифровки.\n\nФОРМАТ ВЫВОДА (строго):\n⚠️ Обнаружены противоречия: <список через • на одной строке или несколько строк>\n\n🤔 Обнаружены недосказанности: <список через •>\n\n❗ Недостающая критическая информация: <список через •>\n\n✅ Анализ завершен. Уровень уверенности: высокий|средний|низкий\n\nОГРАНИЧЕНИЯ:\n- Не добавляй лишних разделов.\n- Не используй Markdown-блоки кода.\n- Если пунктов нет, укажи "нет" после двоеточия.\n\nРАСШИФРОВКА ВСТРЕЧИ:\n"""\n${conversationContext}\n"""`;
  try {
    const analysisStream = await streamText({
      model,
      temperature: 0.2,
      messages: [{ role: 'user', content: analysisStreamPrompt }],
    });

    for await (const part of analysisStream.fullStream) {
      if (part.type !== 'text-delta') continue;
      const delta = String(part.text ?? '');
      if (!delta) continue;
      dataStream.write({ type: 'text-delta', id: progressId, delta });
      analysisStreamed = true;
    }

    if (analysisStreamed) {
      dataStream.write({ type: 'text-delta', id: progressId, delta: '\n' });
    }
  } catch (error) {
    console.error('Analysis stream error:', error);
  }

  try {
    const { object: analysisResult } = await generateObject({
      model,
      temperature: 0.2,
      schema: TranscriptAnalysisSchema,
      prompt: analysisPrompt,
    });
    analysis = analysisResult;
    if (!analysisStreamed) {
      // Выводим результаты анализа, если стриминг не сработал
      if (analysis.hasContradictions && analysis.contradictions.length > 0) {
        dataStream.write({
          type: 'text-delta',
          id: progressId,
          delta: '⚠️ **Обнаружены противоречия:**\n',
        });
        for (const contradiction of analysis.contradictions) {
          dataStream.write({
            type: 'text-delta',
            id: progressId,
            delta: `  • ${contradiction}\n`,
          });
        }
        dataStream.write({ type: 'text-delta', id: progressId, delta: '\n' });
      }

      if (analysis.hasAmbiguities && analysis.ambiguities.length > 0) {
        dataStream.write({
          type: 'text-delta',
          id: progressId,
          delta: '🤔 **Обнаружены недосказанности:**\n',
        });
        for (const ambiguity of analysis.ambiguities) {
          dataStream.write({
            type: 'text-delta',
            id: progressId,
            delta: `  • ${ambiguity}\n`,
          });
        }
        dataStream.write({ type: 'text-delta', id: progressId, delta: '\n' });
      }

      if (analysis.missingCriticalInfo.length > 0) {
        dataStream.write({
          type: 'text-delta',
          id: progressId,
          delta: '❗ **Недостающая критическая информация:**\n',
        });
        for (const missing of analysis.missingCriticalInfo) {
          dataStream.write({
            type: 'text-delta',
            id: progressId,
            delta: `  • ${missing}\n`,
          });
        }
        dataStream.write({ type: 'text-delta', id: progressId, delta: '\n' });
      }

      dataStream.write({
        type: 'text-delta',
        id: progressId,
        delta: `✅ Анализ завершен. Уровень уверенности: ${analysis.confidence === 'high' ? 'высокий' : analysis.confidence === 'medium' ? 'средний' : 'низкий'}\n\n`,
      });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    if (!analysisStreamed) {
      dataStream.write({
        type: 'text-delta',
        id: progressId,
        delta: '⚠️ Не удалось провести полный анализ, продолжаю генерацию протокола...\n\n',
      });
    }
  }

  // Шаг 2: Генерация протокола обследования
  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '📝 Шаг 2/2: Формирование протокола обследования\n',
  });

  const protocolReasoningPrompt = `Дай краткое обоснование структуры протокола по этой расшифровке.\n\nФОРМАТ:\nКраткое обоснование:\n- <1-2 факта из расшифровки, которые влияют на структуру>\n- <что будет отражено в вопросах/решениях/открытых вопросах>\n- <какие разделы требуют "Информация не предоставлена", если есть>\n\nОГРАНИЧЕНИЯ:\n- Не добавляй новых фактов.\n- Без Markdown-кода.\n- 3-4 буллета максимум.\n\nРАСШИФРОВКА ВСТРЕЧИ:\n"""\n${conversationContext}\n"""`;

  try {
    const protocolReasoningStream = await streamText({
      model,
      temperature: 0.2,
      messages: [{ role: 'user', content: protocolReasoningPrompt }],
    });

    for await (const part of protocolReasoningStream.fullStream) {
      if (part.type !== 'text-delta') continue;
      const delta = String(part.text ?? '');
      if (!delta) continue;
      dataStream.write({ type: 'text-delta', id: progressId, delta });
    }

    dataStream.write({ type: 'text-delta', id: progressId, delta: '\n' });
  } catch (error) {
    console.error('Protocol reasoning stream error:', error);
  }

  const protocolPrompt = `Ты специалист по составлению протоколов обследования.

ТВОЯ ЗАДАЧА:
Создать протокол обследования на основе расшифровки встречи с заказчиком.

СТРОГИЕ ТРЕБОВАНИЯ:
1. Протокол ДОЛЖЕН содержать ВСЕ 10 разделов
2. НЕ ИМПРОВИЗИРУЙ - используй ТОЛЬКО факты из расшифровки
3. Если информация отсутствует, укажи это явно (например, "Информация не предоставлена")
4. Даты должны быть в формате ДД.ММ.ГГГГ
5. Все участники должны быть указаны с полными ФИО и должностями
6. Таблицы должны быть заполнены корректно

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

${analysis ? `
РЕЗУЛЬТАТЫ АНАЛИЗА:
- Противоречия: ${analysis.contradictions.join('; ') || 'не обнаружены'}
- Недосказанности: ${analysis.ambiguities.join('; ') || 'не обнаружены'}
- Недостающая информация: ${analysis.missingCriticalInfo.join('; ') || 'отсутствует'}
` : ''}

РАСШИФРОВКА ВСТРЕЧИ:
"""
${conversationContext}
"""

Сформируй структурированный протокол обследования в соответствии со схемой.`;

  let protocol: Protocol;
  let markdownContent = '';
  try {
    const { object: protocolResult } = await generateObject({
      model,
      temperature,
      schema: ProtocolSchema,
      prompt: protocolPrompt,
    });
    protocol = protocolResult;

    markdownContent = protocolToMarkdown(protocol);

    writeData({ type: 'data-clear', data: null });
    writeData({ type: 'data-title', data: `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${protocol.protocolNumber}` });

    for (const line of markdownContent.split(/\n/)) {
      writeData({ type: 'data-documentDelta', data: `${line}\n` });
    }

    writeData({ type: 'data-finish', data: null });

    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '✅ Протокол обследования сформирован!\n\n',
    });

    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '📄 Протокол готов для скачивания в формате .docx\n',
    });

    try {
      const docxBuffer = await generateProtocolDocx(protocol);
      const base64Docx = docxBuffer.toString('base64');
      writeData({
        type: 'data-docx',
        data: {
          content: base64Docx,
          filename: `Протокол_обследования_${protocol.protocolNumber.replace(/[^0-9]/g, '')}_${protocol.meetingDate.replace(/\./g, '-')}.docx`,
        },
      });
    } catch (docxError) {
      console.error('DOCX generation error:', docxError);
      dataStream.write({
        type: 'text-delta',
        id: progressId,
        delta: '⚠️ Не удалось сгенерировать .docx файл\n',
      });
    }
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
  let md = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${protocol.protocolNumber}\n\n`;

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
  md += 'ФИО\tДолжность\n';
  protocol.participants.customer.people.forEach((p) => {
    md += `${p.fullName}\t${p.position}\n`;
  });

  md += '\n';
  md += `Со стороны Исполнителя ${protocol.participants.executor.organizationName}:\n`;
  md += 'ФИО\tДолжность/роль\n';
  protocol.participants.executor.people.forEach((p) => {
    md += `${p.fullName}\t${p.position}\n`;
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
    md += 'Вкладка\tОсобенности\n';
    protocol.meetingContent.migrationFeatures.forEach((feat) => {
      md += `${feat.tab}\t${feat.features}\n`;
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
  md += 'Со стороны Исполнителя:\tСо стороны Заказчика:\n';
  md += `${protocol.approval.executorSignature.organization}\t\t${protocol.approval.customerSignature.organization}\n\n`;
  md += `${protocol.approval.executorSignature.representative} /______________\t${protocol.approval.customerSignature.representative} /______________\n`;

  return md;
}
