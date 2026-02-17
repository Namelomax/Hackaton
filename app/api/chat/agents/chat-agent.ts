import { streamText, ModelMessage } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';

function buildConversationContext(messages: any[], limit: number = 24): string {
  const list = Array.isArray(messages) ? messages.slice(-limit) : [];
  return list
    .map((msg) => {
      const role = msg?.role || 'user';
      if (typeof msg?.content === 'string') return `${role}: ${msg.content}`;
      if (Array.isArray(msg?.parts)) {
        const text = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text;
        return text ? `${role}: ${text}` : '';
      }
      if (typeof msg?.text === 'string') return `${role}: ${msg.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

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
