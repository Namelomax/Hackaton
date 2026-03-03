import { generateText } from 'ai';
import { SGROrchestrator } from '@/sgr/orchestrator';
import { DEFAULT_PROMPT } from '@/lib/db/repositories/default-promt';
import type { AgentContext } from './types';

const sgr = new SGROrchestrator();

/**
 * Обработка сообщения в чате с применением SGR
 */
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
  
  let finalResponse = qualityCheck.correctedResponse;
  
  // 8. Если документ готов, предлагаем сформировать
  if (documentReady.readyForGeneration && 
      documentReady.suggestedAction === 'ask_confirmation') {
    finalResponse += '\n\n' + (documentReady.messageToUser || 
      'Все данные собраны. Сформировать протокол?');
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