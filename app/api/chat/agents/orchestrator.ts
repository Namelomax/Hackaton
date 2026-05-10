import type { AgentContext } from './types';
import { IntentType } from './classifier';

export interface OrchestratorDecision {
  route: IntentType;
  reason: string;
}

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
    } catch {
      return String(msg.content);
    }
  }
  return '';
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

/** Явная просьба сформировать протокол в документе (правая панель), а не болтовня в чате */
function explicitDocumentGenerationRequest(text: string): boolean {
  const raw = String(text || '')
    .replace(/\u00a0/g, ' ')
    .trim();
  if (!raw) return false;
  const n = raw.toLowerCase().replace(/\s+/g, ' ');
  const c = n.replace(/ё/g, 'е');

  const patterns: RegExp[] = [
    /сделай(те)? протокол/,
    /сформируй(те)? протокол/,
    /сгенерируй(те)? протокол/,
    /подготовь(те)? протокол/,
    /оформи(те)? протокол/,
    /выведи(те)?(\s+в)?\s+документ/,
    /в\s+прав(ую|ой)?\s+панел/,
    /зафиксируй(те)?(\s+в)?\s+документе?/,
    /сформируй(те)?(\s+финальный)?\s+документ/,
    /делай(те)?\s+протокол/,
    /можно(\s+уже)?\s+(делать|формировать|создавать)\s+протокол/,
    /хорошо[,.\s]*(все|всё)\s+верно[,.\s]*.*протокол/,
    /(все|всё)\s+верно[,.\s]*.*сделай(те)?\s+протокол/,
    /готов(о)?[,.\s]*формируй(те)?(\s+протокол)?/,
    /финализир(уй|ируйте)(\s+протокол)?/,
  ];

  return patterns.some((re) => re.test(c));
}

export function decideNextAction(context: AgentContext, intent: IntentType): OrchestratorDecision {
  const uiMsgs = Array.isArray((context as any)?.uiMessages) ? (context as any).uiMessages : [];

  const lastUiUser = Array.isArray(uiMsgs)
    ? [...uiMsgs].reverse().find((m: any) => m?.role === 'user')
    : null;

  const uploadOnly = Boolean(lastUiUser && uiMessageHasAttachments(lastUiUser) && !uiMessageText(lastUiUser).trim());

  if (uploadOnly) {
    return { route: 'chat', reason: 'Upload-only: continue dialogue, do not generate document on file upload.' };
  }

  const lastUserPlain = uiMessageText(lastUiUser || {}).trim();

  if (explicitDocumentGenerationRequest(lastUserPlain)) {
    return {
      route: 'document',
      reason: 'User explicitly asked to generate the protocol document (panel output).',
    };
  }

  return {
    route: intent,
    reason:
      intent === 'document'
        ? 'Classifier determined document generation is needed.'
        : 'Classifier determined chat interaction should continue.',
  };
}
