import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import type { AgentContext } from './types';

export type IntentType = 'chat' | 'document';

function looksLikeExplicitDocumentCommand(text: string): boolean {
  const t = (text || '').toLowerCase();
  if (!t) return false;

  const editVerb =
    t.includes('измени') ||
    t.includes('передел') ||
    t.includes('отредакт') ||
    t.includes('поправ') ||
    t.includes('замени') ||
    t.includes('добав') ||
    t.includes('убер') ||
    t.includes('удали') ||
    t.includes('исключ') ||
    t.includes('внеси') ||
    t.includes('дополни');

  const docTargetHint =
    t.includes('в документ') ||
    t.includes('в регламент') ||
    t.includes('в протокол') ||
    t.includes('пункт') ||
    t.includes('раздел') ||
    t.includes('регламент') ||
    t.includes('протокол') ||
    t.includes('документ');

  const genVerb =
    t.includes('сформируй') ||
    t.includes('сформировать') ||
    t.includes('сформируем') ||
    t.includes('составь') ||
    t.includes('составить') ||
    t.includes('составим') ||
    t.includes('сгенерируй') ||
    t.includes('сгенерировать') ||
    t.includes('сгенерируем') ||
    t.includes('подготовь') ||
    t.includes('подготовить') ||
    t.includes('подготовим') ||
    t.includes('оформи') ||
    t.includes('оформить') ||
    t.includes('оформим') ||
    t.includes('сделай') ||
    t.includes('сделать') ||
    t.includes('сделаем') ||
    t.includes('сделайте') ||
    t.includes('выведи') ||
    t.includes('покажи') ||
    t.includes('дай');

  const docNoun =
    t.includes('регламент') ||
    t.includes('документ') ||
    t.includes('протокол') ||
    t.includes('обследован') ||
    t.includes('инструкц') ||
    t.includes('положение') ||
    t.includes('политик') ||
    t.includes('итогов') ||
    t.includes('финальн');

  return (editVerb && docTargetHint) || (genVerb && docNoun);
}

function stripAttachmentNoise(text: string): string {
  if (!text) return '';
  return String(text)
    // Our server-side file injection blocks
    .replace(/\n---\nВложенный файл:[\s\S]*?\n---/g, '')
    // Hidden tags (if any)
    .replace(/<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi, '')
    .trim();
}

function contentToText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // CoreMessage content can be an array of parts.
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

function uiMessageHasAttachments(msg: any): boolean {
  if (!msg) return false;
  if (Array.isArray(msg?.parts) && msg.parts.some((p: any) => p?.type === 'file')) return true;
  if (Array.isArray(msg?.metadata?.attachments) && msg.metadata.attachments.length > 0) return true;
  return false;
}

function getLastUserTextForIntent(context: AgentContext): { text: string; isUpload: boolean } {
  const uiMessages: any[] = Array.isArray((context as any).uiMessages) ? ((context as any).uiMessages as any[]) : [];
  if (uiMessages.length > 0) {
    const lastUiUser = [...uiMessages].reverse().find((m) => m?.role === 'user');
    const text = stripAttachmentNoise(uiMessageText(lastUiUser));
    const isUpload = uiMessageHasAttachments(lastUiUser) && !text.trim();
    return { text, isUpload };
  }

  const msgs: any[] = Array.isArray((context as any).messages) ? ((context as any).messages as any[]) : [];
  const last = msgs[msgs.length - 1];
  const raw = contentToText(last?.content);
  const text = stripAttachmentNoise(raw);
  return { text, isUpload: false };
}

export async function classifyIntent(context: AgentContext): Promise<IntentType> {
  const { messages, userPrompt, model } = context;

  // Берем достаточно контекста для понимания стадии диалога
  const conversationContext = messages.slice(-12);
  const { text: lastUserText, isUpload } = getLastUserTextForIntent(context);

  // If the user only uploaded a file (no text), we should continue the dialogue (chat),
  // not auto-generate the final document.
  if (isUpload) {
    console.log('🤖 Intent classification: upload-only -> chat');
    return 'chat';
  }

  // Deterministic fast-path for explicit document commands.
  if (looksLikeExplicitDocumentCommand(lastUserText)) {
    console.log('🤖 Intent classification: heuristic override -> document');
    return 'document';
  }

  try {
    // We use generateText instead of generateObject to be more robust with Free/Reasoning models
    // that might output <think> blocks or fail strict JSON schema modes.
    const { text: rawOutput } = await generateText({
      model,
      temperature: 0.1,
      prompt: `Ты классификатор намерений в системе создания регламентов бизнес-процессов.

    Отвечай ТОЛЬКО валидным JSON без Markdown, без блоков кода, без комментариев. 
    Формат: {"type":"chat|document","confidence":0.0-1.0,"reasoning":"..."}

ТВОЯ ЗАДАЧА: определить, хочет ли пользователь СЕЙЧАС получить сформированный документ, или продолжает диалог по сбору информации.

КОНТЕКСТ РАБОТЫ СИСТЕМЫ:
Система работает в 3 этапа:
1. Сбор общей информации о процессе (Этап 1)
2. Детальное описание шагов процесса (Этап 2)  
3. Описание управления процессом (Этап 3)

После завершения сбора информации система формирует итоговый документ-регламент.

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
- Пользователь явно просит показать/вывести/создать итоговый документ
- Пользователь дает команду на формирование регламента
- Пользователь просит изменить/отредактировать уже существующий документ
- Пользователь подтверждает готовность к генерации документа после предложения ассистента
- Пользователь говорит что информация собрана и можно переходить к документу
- Контекст показывает, что сбор информации завершен И пользователь дает финальное подтверждение

Выбирай "chat" если:
- Пользователь отвечает на вопросы ассистента
- Пользователь предоставляет дополнительную информацию
- Пользователь задает уточняющие вопросы
- Пользователь загружает файлы или документы
- Идет процесс обсуждения деталей процесса
- Пользователь дает промежуточные подтверждения в процессе сбора ("хорошо", "понятно", "да")
- Сбор информации еще не завершен

ВАЖНО: 
- Анализируй весь контекст диалога, не только последнее сообщение
- Учитывай, на какой стадии находится процесс сбора информации
- Если ассистент только что предложил сформировать документ и пользователь согласился - это "document"
- Если информация еще собирается - это "chat", даже при коротких подтверждениях

Если не уверен, все равно верни JSON, например:
{"type":"chat","confidence":0,"reasoning":"uncertain"}

Проанализируй ситуацию и верни JSON.`,
    });

    const rawText = String(rawOutput ?? '').trim();
    console.log('🤖 Raw Intent Classification Output:', rawText);

    if (!rawText) {
      console.warn('⚠️ Empty classifier response, falling back to heuristic');
      if (looksLikeExplicitDocumentCommand(lastUserText)) return 'document';
      return 'chat';
    }

    // Clean up response for models that include thinking traces or markdown
    let cleanJson = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '') // Remove deepseek thinking blocks
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    
    // Find the first '{' and last '}' to handle potential preamble/postscript text
    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    }

    console.log('📝 Cleaned JSON for parsing:', cleanJson.substring(0, 200));

    // If cleanJson is empty or doesn't contain braces, fallback immediately
    if (!cleanJson || cleanJson.length < 5 || firstBrace === -1) {
      console.warn('⚠️ Empty or invalid classifier response, falling back to chat');
      if (looksLikeExplicitDocumentCommand(lastUserText)) return 'document';
      return 'chat';
    }

    let intentObj: { type: IntentType; confidence: number; reasoning: string };
    try {
      intentObj = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.warn('Failed to parse intent JSON, falling back to chat.', parseErr);
      // Fallback heuristics if specific keywords are present
      if (looksLikeExplicitDocumentCommand(lastUserText)) return 'document';
      return 'chat';
    }
    
    // Validate type (basic)
    if (intentObj.type !== 'chat' && intentObj.type !== 'document') {
       intentObj.type = 'chat'; // default
    }

    console.log('🤖 Intent classification parsed:', {
      type: intentObj.type,
      confidence: intentObj.confidence,
      reasoning: intentObj.reasoning
    });
    
    if (intentObj.confidence < 0.6) {
      console.warn('⚠️ Low confidence classification:', intentObj);
      if (looksLikeExplicitDocumentCommand(lastUserText)) {
        console.warn('⚠️ Low confidence + heuristic document command -> overriding to document');
        return 'document';
      }
    }
    
    return intentObj.type as IntentType;
  } catch (err) {
    console.error('Intent classification failed:', err);
    if (looksLikeExplicitDocumentCommand(lastUserText)) return 'document';
    return 'chat';
  }
}