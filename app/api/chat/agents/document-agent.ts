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
    delta: '🔍 Анализирую расшифровку встречи на противоречия и недосказанности...\n\n',
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
  try {
    const { object: analysisResult } = await generateObject({
      model,
      temperature: 0.2,
      schema: TranscriptAnalysisSchema,
      prompt: analysisPrompt,
    });
    analysis = analysisResult;

    // Выводим результаты анализа
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
  } catch (error) {
    console.error('Analysis error:', error);
    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '⚠️ Не удалось провести полный анализ, продолжаю генерацию протокола...\n\n',
    });
  }

  // Шаг 2: Генерация протокола обследования
  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '📝 Формирую протокол обследования...\n\n',
  });

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
  try {
    const { object: protocolResult } = await generateObject({
      model,
      temperature,
      schema: ProtocolSchema,
      prompt: protocolPrompt,
    });
    protocol = protocolResult;

    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '✅ Протокол обследования сформирован!\n\n',
    });

    // Шаг 3: Преобразуем в Markdown для отображения
    const markdownContent = protocolToMarkdown(protocol);
    
    writeData({ type: 'data-clear', data: null });
    writeData({ type: 'data-title', data: `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${protocol.protocolNumber}` });
    writeData({ type: 'data-documentDelta', data: markdownContent });
    writeData({ type: 'data-finish', data: null });

    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '📄 Протокол готов для скачивания в формате .docx\n',
    });

    // Шаг 4: Генерируем .docx и сохраняем
    try {
      const docxBuffer = await generateProtocolDocx(protocol);
      // Сохраняем в base64 для передачи клиенту
      const base64Docx = docxBuffer.toString('base64');
      writeData({ 
        type: 'data-docx', 
        data: { 
          content: base64Docx,
          filename: `Протокол_обследования_${protocol.protocolNumber.replace(/[^0-9]/g, '')}_${protocol.meetingDate.replace(/\./g, '-')}.docx`
        } 
      });
    } catch (docxError) {
      console.error('DOCX generation error:', docxError);
      dataStream.write({
        type: 'text-delta',
        id: progressId,
        delta: '⚠️ Не удалось сгенерировать .docx файл\n',
      });
    }

    dataStream.write({ type: 'text-end', id: progressId });
    
    return markdownContent;
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
}

/**
 * Преобразует структурированный протокол в Markdown для отображения
 */
function protocolToMarkdown(protocol: Protocol): string {
  let md = `# ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${protocol.protocolNumber}\n\n`;

  // 1. Дата встречи
  md += `## 1. Дата встречи\n${protocol.meetingDate}\n\n`;

  // 2. Повестка
  md += `## 2. Повестка\n${protocol.agenda.title}\n\n`;
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item) => {
      md += `- ${item}\n`;
    });
    md += '\n';
  }

  // 3. Участники
  md += `## 3. Участники\n\n`;
  md += `### Со стороны Заказчика ${protocol.participants.customer.organizationName}:\n\n`;
  md += '| ФИО | Должность |\n';
  md += '|-----|----------|\n';
  protocol.participants.customer.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });
  md += '\n';

  md += `### Со стороны Исполнителя ${protocol.participants.executor.organizationName}:\n\n`;
  md += '| ФИО | Должность/роль |\n';
  md += '|-----|---------------|\n';
  protocol.participants.executor.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });
  md += '\n';

  // 4. Термины и определения
  md += `## 4. Термины и определения\n\n`;
  protocol.termsAndDefinitions.forEach((term) => {
    md += `- **${term.term}** – ${term.definition}\n`;
  });
  md += '\n';

  // 5. Сокращения и обозначения
  md += `## 5. Сокращения и обозначения\n\n`;
  protocol.abbreviations.forEach((abbr) => {
    md += `- **${abbr.abbreviation}** – ${abbr.fullForm}\n`;
  });
  md += '\n';

  // 6. Содержание встречи
  md += `## 6. Содержание встречи\n\n`;
  if (protocol.meetingContent.introduction) {
    md += `${protocol.meetingContent.introduction}\n\n`;
  }
  protocol.meetingContent.topics.forEach((topic) => {
    md += `### ${topic.title}\n\n`;
    md += `${topic.content}\n\n`;
    if (topic.subtopics && topic.subtopics.length > 0) {
      topic.subtopics.forEach((sub) => {
        if (sub.title) {
          md += `#### ${sub.title}\n\n`;
        }
        md += `${sub.content}\n\n`;
      });
    }
  });

  if (protocol.meetingContent.migrationFeatures && protocol.meetingContent.migrationFeatures.length > 0) {
    md += `### Особенности миграции по вкладкам МТР\n\n`;
    md += '| Вкладка | Особенности |\n';
    md += '|---------|-------------|\n';
    protocol.meetingContent.migrationFeatures.forEach((feat) => {
      md += `| ${feat.tab} | ${feat.features} |\n`;
    });
    md += '\n';
  }

  // 7. Вопросы
  md += `## 7. Вопросы\n\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `${i + 1}. ${qa.question}\n`;
  });
  md += '\n### Ответы:\n\n';
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `${i + 1}. ${qa.answer}\n\n`;
  });

  // 8. Решения
  md += `## 8. Решения\n\n`;
  protocol.decisions.forEach((decision, i) => {
    md += `${i + 1}. ${decision.decision}\n`;
    md += `   **Ответственный:** ${decision.responsible}\n\n`;
  });

  // 9. Открытые вопросы
  md += `## 9. Открытые вопросы\n\n`;
  protocol.openQuestions.forEach((q, i) => {
    md += `${i + 1}. ${q}\n`;
  });
  md += '\n';

  // 10. Согласовано
  md += `## 10. Согласовано\n\n`;
  md += '| Со стороны Исполнителя | Со стороны Заказчика |\n';
  md += '|------------------------|----------------------|\n';
  md += `| ${protocol.approval.executorSignature.organization}<br><br>${protocol.approval.executorSignature.representative} /______________ | ${protocol.approval.customerSignature.organization}<br><br>${protocol.approval.customerSignature.representative} /______________ |\n`;

  return md;
}
