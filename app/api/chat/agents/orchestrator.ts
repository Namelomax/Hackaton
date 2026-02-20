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

// Orchestrator: trust the classifier completely, no heuristic overrides.
export function decideNextAction(context: AgentContext, intent: IntentType): OrchestratorDecision {
  const msgs = context?.messages || [];
  const uiMsgs = Array.isArray((context as any)?.uiMessages) ? (context as any).uiMessages : [];

  const lastUiUser = Array.isArray(uiMsgs)
    ? [...uiMsgs].reverse().find((m: any) => m?.role === 'user')
    : null;

  const uploadOnly = Boolean(lastUiUser && uiMessageHasAttachments(lastUiUser) && !uiMessageText(lastUiUser).trim());

  if (uploadOnly) {
    return { route: 'chat', reason: 'Upload-only: continue dialogue, do not generate document on file upload.' };
  }

  // The classifier has already made the decision based on full context and LLM analysis.
  // We simply trust it and route accordingly.
  return {
    route: intent,
    reason: intent === 'document' 
      ? 'Classifier determined document generation is needed.'
      : 'Classifier determined chat interaction should continue.',
  };
}
