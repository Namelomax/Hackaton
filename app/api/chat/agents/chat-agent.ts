import { streamText, ModelMessage } from 'ai';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import { generateText } from 'ai';
import { SGROrchestrator } from '@/sgr/orchestrator';
import { DEFAULT_PROMPT } from '@/lib/db/repositories/default-promt';
import type { AgentContext } from './types';

const sgr = new SGROrchestrator();

/**
 * Обработка сообщения в чате с применением SGR
 */

function hasAttachedFiles(messages: any[]): boolean {
  return messages.some((msg) => {
    if (typeof msg?.content === 'string') {
      return msg.content.includes('AI-HIDDEN') || msg.content.includes('Вложенный файл');
    }
    if (Array.isArray(msg?.parts)) {
      return msg.parts.some((p: any) => p?.type === 'file');
    }
    return false;
  });
}

function adaptSystemPrompt(systemPrompt: string, hasFiles: boolean, messageCount: number): string {
  // Если файлы загружены или сообщений уже больше одного → расшифровка получена
  if ((hasFiles || messageCount > 1) && !systemPrompt.includes('АДАПТАЦИЯ: Расшифровка получена')) {
    const adaptation = `АДАПТАЦИЯ: Расшифровка получена
════════════════════════════════════════════
⚡ ПРОПУСТИ ЭТАП 1 (приветствие)!
⚡ Ты уже имеешь расшифровку встречи.
⚡ НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации).
⚡ Начни со сбора участников встречи и их ФИО.
⚡ НЕ показывай приветствие "Привет! Я AI-агент..."
════════════════════════════════════════════

`;
    return adaptation + systemPrompt;
  }
  return systemPrompt;
}

export async function handleChatMessage(context: AgentContext): Promise<string> {
  console.log('🤖 Chat Agent: обработка сообщения с SGR');
  
  // 1. Получаем последнее сообщение пользователя
  const lastUserMessage = getLastUserMessage(context);
  
  // 2. Классифицируем намерение (проблема 10)
  const intent = await sgr.classifyIntent(
    lastUserMessage,
    context.messages.slice(-12)
  );
  
  console.log('🎯 Intent classification:', intent);
  
  // 3. Если пользователь явно хочет документ с высокой уверенностью
  if (intent.intent === 'document' && intent.confidence > 0.7) {
    // Возвращаем специальный сигнал для роутинга
    return JSON.stringify({
      __type: 'route_to_document',
      reason: intent.reasoning
    });
  }
  
  // 4. Генерируем черновик ответа
  const draftResponse = await generateText({
    model: context.model,
    prompt: `${DEFAULT_PROMPT}\n\nСообщение пользователя: ${context.userPrompt}`,
  });
  
  // 5. Проверяем качество ответа (проблемы 6, 7, 8)
  const qualityCheck = await sgr.checkQuality(
    draftResponse.text,
    lastUserMessage,
    context.messages
  );
  
  console.log('📊 Quality check:', {
  score: qualityCheck.qualityScore,
  ready: qualityCheck.readyToSend,
  nextAction: qualityCheck.nextAction
});
  
  // 6. Если качество низкое, просим перегенерировать
  if (!qualityCheck.readyToSend && qualityCheck.nextAction === 'regenerate') {
    console.log('🔄 Низкое качество, перегенерируем...');
    return handleChatMessage({
      ...context,
      retryCount: (context.retryCount || 0) + 1
    });
  }
  
  // 7. Проверяем готовность к формированию документа (проблема 9)
  const documentReady = await sgr.checkDocumentReady(context.messages);

  console.log('📋 Document readiness:', {
    filledSections: documentReady.filledSections.length,
    pendingSections: documentReady.pendingSections.length,
    readyForGeneration: documentReady.readyForGeneration,
    suggestedAction: documentReady.suggestedAction
  });

  let finalResponse = qualityCheck.correctedResponse;

  // 8. Если документ готов, предлагаем сформировать
  // ВАЖНО: Проверяем, что все 10 разделов заполнены
  if (documentReady.readyForGeneration &&
      documentReady.suggestedAction === 'ask_confirmation' &&
      documentReady.filledSections.length >= 10) {
    finalResponse += '\n\n' + (documentReady.messageToUser ||
      'Все данные собраны. Сформировать протокол?');
  } else if (documentReady.pendingSections.length > 0) {
    // Если есть незаполненные разделы — добавляем напоминание
    console.log('⏳ Ещё есть незаполненные разделы:', documentReady.pendingSections);
  }
  
  return finalResponse;
}

/**
 * Вспомогательная функция для получения последнего сообщения пользователя
 */
function getLastUserMessage(context: AgentContext): string {
  const userMessages = context.messages.filter(m => m.role === 'user');
  const lastMessage = userMessages[userMessages.length - 1];
  
  if (!lastMessage) return '';
  
  if (typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }
  
  if (Array.isArray(lastMessage.content)) {
    return lastMessage.content
      .map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'image') return '[Изображение]';
        if (part.type === 'file') return `[Файл: ${part.filename || 'документ'}]`;
        return '';
      })
      .join(' ');
  }
  
  return String(lastMessage.content);
}

export async function runChatAgent(context: AgentContext, systemPrompt: string, userPrompt: string) {
  const { messages, model, userId, conversationId } = context;
  const messagesWithUserPrompt: ModelMessage[] = [];
  
  if (userPrompt && userPrompt.trim()) {
    messagesWithUserPrompt.push({
      role: 'system',
      content: userPrompt,
    });
  }
  
  messagesWithUserPrompt.push(...(messages as ModelMessage[]));
  
  // Адаптируем systemPrompt в зависимости от контекста
  const hasFiles = hasAttachedFiles(messages);
  const adaptedSystemPrompt = adaptSystemPrompt(systemPrompt, hasFiles, messages.length);
  
  const stream = streamText({
    model,
    temperature: 0,
    messages: messagesWithUserPrompt,
    system: adaptedSystemPrompt, // System instructions + adaptive header
  });

  return stream.toUIMessageStreamResponse({
    onFinish: async ({ messages: finished }) => {
      if (userId) {
        try {
          if (conversationId) {
            await updateConversation(conversationId, finished);
          } else {
            await saveConversation(userId, finished);
          }
        } catch (e) {
          console.error('chat persistence failed', e);
        }
      }
    },
  });
}