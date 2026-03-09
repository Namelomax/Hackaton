import type { AgentContext } from './types';
import { IntentType } from './classifier';

export interface OrchestratorDecision {
  route: IntentType;
  reason: string;
}

/**
 * SGR-схема для оркестрации (Schema-Guided Reasoning)
 * Применяет паттерн Routing для выбора между chat и document с явными правилами
 */
interface SgrOrchestrationSchema {
  /** Этап 1: Анализ контекста */
  stage_1_context: {
    message_count: number;
    has_attachments: boolean;
    has_document_content: boolean;
    last_user_message_text: string;
  };

  /** Этап 2: Проверка специальных случаев */
  stage_2_special_cases: {
    is_upload_only: boolean;
    is_fix_request: boolean;
    is_document_edit_request: boolean;
  };

  /** Этап 3: Применение правил маршрутизации */
  stage_3_routing_rules: {
    rule_applied: string;
    route_determined: 'chat' | 'document';
    confidence: 'high' | 'medium' | 'low';
  };

  /** Этап 4: Финальная верификация */
  stage_4_verification: {
    route_consistent_with_intent: boolean;
    no_conflicting_signals: boolean;
    final_decision: OrchestratorDecision;
  };
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

/**
 * Orchestrator с явными правилами маршрутизации на основе SGR
 * 
 * SGR-принципы:
 * 1. Cascade: последовательное применение правил
 * 2. Routing: классификация запроса перед маршрутизацией
 * 3. Verification: проверка корректности выбора
 */
export function decideNextAction(context: AgentContext, intent: IntentType): OrchestratorDecision {
  const msgs = context?.messages || [];
  const uiMsgs = Array.isArray((context as any)?.uiMessages) ? (context as any).uiMessages : [];
  const hasDocumentContent = Boolean(context?.documentContent && context.documentContent.trim());

  // SGR Этап 1: Анализ контекста
  const lastUiUser = Array.isArray(uiMsgs)
    ? [...uiMsgs].reverse().find((m: any) => m?.role === 'user')
    : null;

  const contextAnalysis = {
    message_count: msgs.length,
    has_attachments: uiMsgs.some(uiMessageHasAttachments),
    has_document_content: hasDocumentContent,
    last_user_message_text: lastUiUser ? uiMessageText(lastUiUser) : '',
  };

  // SGR Этап 2: Проверка специальных случаев
  const uploadOnly = Boolean(lastUiUser && uiMessageHasAttachments(lastUiUser) && !uiMessageText(lastUiUser).trim());
  
  const lastUserText = contextAnalysis.last_user_message_text.toLowerCase();
  const isFixRequest = lastUserText.includes('исправь') && 
                       (lastUserText.includes('замечан') || lastUserText.includes('ошибк') || lastUserText.includes('предлож'));
  const isDocumentEditRequest = lastUserText.includes('измени') && 
                                (lastUserText.includes('документ') || lastUserText.includes('протокол'));

  const specialCases = {
    is_upload_only: uploadOnly,
    is_fix_request: isFixRequest && hasDocumentContent,
    is_document_edit_request: isDocumentEditRequest && hasDocumentContent,
  };

  // SGR Этап 3: Применение правил маршрутизации
  let route: 'chat' | 'document' = 'chat';
  let ruleApplied = '';
  let confidence: 'high' | 'medium' | 'low' = 'medium';

  // Приоритет правил (от высшего к низшему)
  if (specialCases.is_upload_only) {
    // Правило 1: Только загрузка файла → chat (не генерируем документ автоматически)
    route = 'chat';
    ruleApplied = 'UPLOAD_ONLY: продолжение диалога после загрузки файла';
    confidence = 'high';
  } else if (specialCases.is_fix_request) {
    // Правило 2: Запрос на исправление замечаний → chat (используем SGR-fix промпт)
    route = 'chat';
    ruleApplied = 'FIX_REQUEST: обработка замечаний через SGR-fix промпт';
    confidence = 'high';
  } else if (specialCases.is_document_edit_request) {
    // Правило 3: Запрос на изменение документа → chat (с контекстом документа)
    route = 'chat';
    ruleApplied = 'DOCUMENT_EDIT: редактирование с учётом существующего документа';
    confidence = 'high';
  } else if (intent === 'document') {
    // Правило 4: Classifier определил document → document
    route = 'document';
    ruleApplied = 'CLASSIFIER_DOCUMENT: classifier определил готовность к документу';
    confidence = 'high';
  } else {
    // Правило 5: По умолчанию → chat (продолжение сбора информации)
    route = 'chat';
    ruleApplied = 'DEFAULT: продолжение диалога для сбора информации';
    confidence = 'medium';
  }

  const routingRules = {
    rule_applied: ruleApplied,
    route_determined: route,
    confidence,
  };

  // SGR Этап 4: Финальная верификация
  const routeConsistentWithIntent = (route === intent) || 
                                     specialCases.is_upload_only || 
                                     specialCases.is_fix_request ||
                                     specialCases.is_document_edit_request;
  
  const noConflictingSignals = !(specialCases.is_upload_only && intent === 'document');

  const finalDecision: OrchestratorDecision = {
    route,
    reason: `${ruleApplied}. Intent classifier: ${intent}. Контекст: сообщений=${contextAnalysis.message_count}, файлы=${contextAnalysis.has_attachments}, документ=${contextAnalysis.has_document_content}.`,
  };

  const verification = {
    route_consistent_with_intent: routeConsistentWithIntent,
    no_conflicting_signals: noConflictingSignals,
    final_decision: finalDecision,
  };

  // Логирование SGR-оркестрации
  console.log('[orchestrator] === SGR-ОРКЕСТРАЦИЯ ===');
  console.log('[orchestrator] Этап 1 (Контекст):', contextAnalysis);
  console.log('[orchestrator] Этап 2 (Спец. случаи):', specialCases);
  console.log('[orchestrator] Этап 3 (Маршрутизация):', routingRules);
  console.log('[orchestrator] Этап 4 (Верификация):', verification);
  console.log('[orchestrator] === ФИНАЛЬНОЕ РЕШЕНИЕ ===');
  console.log('[orchestrator] Маршрут:', finalDecision.route);
  console.log('[orchestrator] Причина:', finalDecision.reason);

  return finalDecision;
}
