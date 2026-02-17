import { generateText } from 'ai';
import type { AgentContext } from './types';

export type IntentType = 'chat' | 'document';

function stripAttachmentNoise(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/\n---\nВложенный файл:[\s\S]*?\n---/g, '')
    .replace(/<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi, '')
    .trim();
}

function contentToText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p?.text === 'string') return p.text;
        if (typeof p?.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object') {
    if (typeof (content as any).text === 'string') return (content as any).text;
    if (typeof (content as any).content === 'string') return (content as any).content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function uiMessageText(msg: any): string {
  if (!msg) return '';
  if (Array.isArray(msg?.parts)) {
    const t = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text;
    if (t) return String(t);
  }
  if (typeof msg?.content === 'string') return msg.content;
  if (typeof msg?.text === 'string') return msg.text;
  return '';
}

function getLastUserTextForIntent(context: AgentContext): string {
  const uiMessages: any[] = Array.isArray((context as any).uiMessages) ? ((context as any).uiMessages as any[]) : [];
  if (uiMessages.length > 0) {
    const lastUiUser = [...uiMessages].reverse().find((m) => m?.role === 'user');
    const text = stripAttachmentNoise(uiMessageText(lastUiUser));
    return text;
  }

  const msgs: any[] = Array.isArray((context as any).messages) ? ((context as any).messages as any[]) : [];
  const last = msgs[msgs.length - 1];
  const raw = contentToText(last?.content);
  const text = stripAttachmentNoise(raw);
  return text;
}

export async function classifyIntent(context: AgentContext): Promise<IntentType> {
  const { messages, userPrompt, model } = context;

  const conversationContext = messages.slice(-12);
  const lastUserText = getLastUserTextForIntent(context);

  try {
    const { text: rawOutput } = await generateText({
      model,
      temperature: 0.1,
      prompt: `Ты классификатор намерений в системе создания протоколов обследования.

Отвечай ТОЛЬКО валидным JSON без Markdown, без блоков кода, без комментариев. 
Формат: {"type":"chat|document","confidence":0.0-1.0,"reasoning":"..."}

ТВОЯ ЗАДАЧА: определить, хочет ли пользователь СЕЙЧАС получить сформированный документ, или продолжает диалог по сбору информации.

КОНТЕКСТ РАБОТЫ СИСТЕМЫ:
Система работает в 2 этапа:
1. Диалог: сбор информации через уточняющие вопросы (chat-агент)
2. Документ: формирование финального протокола на основе собранной информации (document-агент)

ИНСТРУКЦИИ ДЛЯ АССИСТЕНТА (как он работает):
${userPrompt}

ИСТОРИЯ ДИАЛОГА (последние сообщения):
${conversationContext.map((msg, i) => {
  const content = contentToText((msg as any).content);
  return `[${i + 1}] ${msg.role}: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`;
}).join('\n\n')}

ПОСЛЕДНЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
"${lastUserText}"

КРИТЕРИИ АНАЛИЗА:

Выбирай "document" если:
- Пользователь явно просит показать/вывести/создать итоговый протокол
- Пользователь дает команду на формирование документа
- Пользователь просит изменить/отредактировать существующий документ с конкретными указаниями
- Пользователь подтверждает готовность к финализации после предложения ассистента
- Ассистент задал вопрос о готовности к формированию протокола, и пользователь подтвердил (например: "все верно", "да", "готово")
- Пользователь говорит что информация собрана и можно переходить к документу
- Контекст показывает завершение сбора информации И финальное подтверждение

Выбирай "chat" если:
- Пользователь отвечает на уточняющие вопросы
- Пользователь предоставляет дополнительную информацию
- Пользователь задает вопросы
- Пользователь загружает файлы или документы
- Идет процесс обсуждения деталей
- Пользователь дает промежуточные подтверждения ("верно", "да", "согласен")
- Сбор информации еще не завершен

ВАЖНО: 
- Анализируй весь контекст диалога, не только последнее сообщение
- Учитывай стадию сбора информации
- Промежуточные подтверждения во время диалога = "chat"
- Финальное подтверждение завершенной информации = может быть "document"

Проанализируй ситуацию и верни JSON.`,
    });

    const rawText = String(rawOutput ?? '').trim();
    console.log('🤖 Raw Intent Classification Output:', rawText);

    if (!rawText) {
      console.warn('⚠️ Empty classifier response, defaulting to chat');
      return 'chat';
    }

    let cleanJson = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    }

    console.log('📝 Cleaned JSON for parsing:', cleanJson.substring(0, 200));

    if (!cleanJson || cleanJson.length < 5 || firstBrace === -1) {
      console.warn('⚠️ Empty or invalid classifier response, defaulting to chat');
      return 'chat';
    }

    let intentObj: { type: IntentType; confidence: number; reasoning: string };
    try {
      intentObj = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.warn('Failed to parse intent JSON, defaulting to chat.', parseErr);
      return 'chat';
    }
    
    if (intentObj.type !== 'chat' && intentObj.type !== 'document') {
       intentObj.type = 'chat';
    }

    console.log('🤖 Intent classification parsed:', {
      type: intentObj.type,
      confidence: intentObj.confidence,
      reasoning: intentObj.reasoning
    });
    
    return intentObj.type as IntentType;
  } catch (err) {
    console.error('Intent classification failed:', err);
    return 'chat';
  }
}