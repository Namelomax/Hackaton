import { generateText } from 'ai';
import { SGROrchestrator } from '@/sgr/orchestrator';
import type { AgentContext } from './types';

const sgr = new SGROrchestrator();

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
  return String(content);
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

/**
 * Резервный метод классификации (на всякий случай)
 */
function fallbackHeuristic(lastMessage: string, context: any[]): IntentType {
  const lastMsg = lastMessage.toLowerCase();
  
  // Явные признаки запроса документа
  if (lastMsg.includes('протокол') || 
      lastMsg.includes('документ') || 
      lastMsg.includes('сформируй') ||
      lastMsg.includes('покажи') ||
      lastMsg.includes('готов') ||
      lastMsg.includes('выведи')) {
    return 'document';
  }
  
  // Проверка контекста - если ассистент спрашивал про готовность
  const lastAssistantMsg = [...context].reverse().find(m => m.role === 'assistant')?.content || '';
  if (lastAssistantMsg.includes('сформировать протокол') && 
      (lastMsg.includes('да') || lastMsg.includes('верно') || lastMsg.includes('готово'))) {
    return 'document';
  }
  
  return 'chat';
}

export async function classifyIntent(context: AgentContext): Promise<IntentType> {
  console.log('🤖 Intent Classifier: запуск с SGR');
  
  const lastMessage = getLastUserTextForIntent(context);
  const conversationContext = context.messages.slice(-12);
  
  try {
    // Используем SGR для классификации
    const result = await sgr.classifyIntent(lastMessage, conversationContext);
    
    console.log('🎯 SGR Intent Classification:', {
      intent: result.intent,
      confidence: result.confidence,
      reasoning: result.reasoning,
      nextStep: result.nextStep,
    });
    
    // Если уверенность низкая, используем fallback
    if (result.confidence < 0.6) {
      console.log('⚠️ Low confidence SGR, falling back to heuristic');
      return fallbackHeuristic(lastMessage, conversationContext);
    }
    
    return result.intent;
    
  } catch (error) {
    console.error('❌ SGR classification failed:', error);
    console.log('⚠️ Using fallback heuristic');
    return fallbackHeuristic(lastMessage, conversationContext);
  }
}