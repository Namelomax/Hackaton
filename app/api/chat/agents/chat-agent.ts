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

function adaptSystemPrompt(systemPrompt: string, hasFiles: boolean, messageCount: number, hasDocumentContent: boolean): string {
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

/**
 * Специальный промпт для обработки замечаний по документу
 */
function buildFixIssuesPrompt(existingDocument: string, issuesText: string): string {
  return `ТЫ — редактор деловых документов. Твоя задача — исправить документ по замечаниям.

ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА:
\`\`\`
${existingDocument}
\`\`\`

ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:
${issuesText}

════════════════════════════════════════════
ИНСТРУКЦИЯ ПО ИСПРАВЛЕНИЮ:
════════════════════════════════════════════

1. ВНИМАТЕЛЬНО прочитай каждое замечание
2. Найди в документе место, к которому относится замечание
3. ИСПРАВЬ ошибку согласно предложению
4. СОХРАНИ структуру документа (все 10 разделов протокола)
5. НЕ удаляй существующую информацию, только исправляй ошибки
6. Если замечание касается формата (таблицы, списки) — исправь форматирование
7. Если замечание касается содержания — добавь/исправь информацию
8. После всех исправлений — покажи ИСПРАВЛЕННУЮ ВЕРСИЮ всего документа

════════════════════════════════════════════
ФОРМАТ ОТВЕТА:
════════════════════════════════════════════

Сначала кратко перечисли, какие замечания ты исправил:
"Исправлены следующие замечания:
1. [замечание 1] — исправлено
2. [замечание 2] — исправлено
..."

Затем покажи ПОЛНУЮ исправленную версию документа в формате Markdown.

════════════════════════════════════════════
ВАЖНО:
════════════════════════════════════════════

- Не игнорируй ни одно замечание
- Если замечание непонятно — спроси уточнение
- Если исправление требует дополнительной информации — запроси её
- Сохраняй деловой стиль документа`;
}

export async function runChatAgent(context: AgentContext, systemPrompt: string, userPrompt: string) {
  const { messages, model, userId, conversationId, documentContent } = context;
  const messagesWithUserPrompt: ModelMessage[] = [];

  // Добавляем системный промпт от пользователя
  if (userPrompt && userPrompt.trim()) {
    messagesWithUserPrompt.push({
      role: 'system',
      content: userPrompt,
    });
  }

  // Проверяем, есть ли в сообщениях запрос на исправление замечаний
  const lastUserMessage = messages[messages.length - 1];
  let lastUserText = '';
  
  if (lastUserMessage) {
    const msg = lastUserMessage as any;
    if (typeof msg.content === 'string') {
      lastUserText = msg.content;
    } else if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string');
      lastUserText = textPart?.text || '';
    }
  }
  
  const hasFixRequest = lastUserText.includes('исправь') && 
                        (lastUserText.includes('замечан') || lastUserText.includes('ошибк') || lastUserText.includes('предлож'));

  // Если это запрос на исправление замечаний И есть документ — используем специальный промпт
  if (hasFixRequest && documentContent && documentContent.trim()) {
    // Извлекаем текст замечаний из сообщения пользователя
    const issuesMatch = lastUserText.match(/ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:([\s\S]*)/i);
    const issuesText = issuesMatch ? issuesMatch[1] : lastUserText;
    
    const fixPrompt = buildFixIssuesPrompt(documentContent, issuesText);
    messagesWithUserPrompt.push({
      role: 'system',
      content: fixPrompt,
    });
    
    // Добавляем только последнее сообщение пользователя (остальные не нужны для исправления)
    messagesWithUserPrompt.push(lastUserMessage);
  } else {
    // Добавляем контекст документа, если он есть (пользователь редактировал вручную)
    if (documentContent && documentContent.trim()) {
      messagesWithUserPrompt.push({
        role: 'system',
        content: `ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n\n${documentContent}\n\nИспользуй эту версию как основу для дальнейшей работы. Если пользователь вносит изменения в документ, сохраняй их и учитывай в следующих ответах.`,
      });
    }

    messagesWithUserPrompt.push(...(messages as ModelMessage[]));
  }

  // Адаптируем systemPrompt в зависимости от контекста
  const hasFiles = hasAttachedFiles(messages);
  const adaptedSystemPrompt = adaptSystemPrompt(systemPrompt, hasFiles, messages.length, !!documentContent);

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
