/**
 * Оркестрация анонимизации на уровне диалога.
 *
 * Главный принцип скорости: удалённый сервер (20–30 c на документ) дёргаем
 * ТОЛЬКО для нового текста. Уже известные значения подставляем локально и
 * детерминированно по каноническому mapping диалога (`applyMappingForward`).
 */
import {
  getConversationMapping,
  saveConversationMapping,
} from '@/lib/getPromt';
import { anonymizeRemote, AnonymizerUnavailableError } from './remote-client';
import { applyMappingForward, countersFromMapping, mergeRemoteResult } from './merge';
import { deanonymize, deepDeanonymize } from './deanonymize';
import type { ConversationMapping, Mapping } from './types';

export { AnonymizerUnavailableError };
export { deanonymize, deepDeanonymize };
export { applyMappingForward };
export type { Mapping, ConversationMapping };

async function loadConversation(conversationId?: string | null): Promise<ConversationMapping> {
  if (!conversationId) return { mapping: {}, counters: {} };
  const stored = await getConversationMapping(conversationId);
  const counters =
    stored.counters && Object.keys(stored.counters).length > 0
      ? stored.counters
      : countersFromMapping(stored.mapping ?? {});
  return { mapping: stored.mapping ?? {}, counters };
}

export interface AnonymizeTextResult {
  anonymizedText: string;
  mapping: Mapping;
  added: number;
  summary: Record<string, number>;
}

/**
 * Анонимизировать НОВЫЙ текст: вызвать сервер, влить в канонический mapping,
 * сохранить mapping диалога. Бросает AnonymizerUnavailableError при сбое сервера.
 */
export async function anonymizeNewText(
  text: string,
  conversationId?: string | null,
): Promise<AnonymizeTextResult> {
  const conv = await loadConversation(conversationId);
  if (!text || !text.trim()) {
    return { anonymizedText: text, mapping: conv.mapping, added: 0, summary: {} };
  }

  const remote = await anonymizeRemote(text);
  const merged = mergeRemoteResult(conv, remote);

  if (conversationId && merged.added > 0) {
    await saveConversationMapping(conversationId, merged.conversation);
  }

  return {
    anonymizedText: merged.anonymizedText,
    mapping: merged.conversation.mapping,
    added: merged.added,
    summary: remote.summary ?? {},
  };
}

/**
 * Быстрая локальная анонимизация по уже известному mapping (без вызова сервера).
 * Для документа/истории на повторных ходах диалога.
 */
export function anonymizeWithMapping(text: string, mapping: Mapping): string {
  return applyMappingForward(text, mapping);
}

/** Загрузить только mapping диалога (для деанонимизации ответа). */
export async function loadConversationMapping(
  conversationId?: string | null,
): Promise<Mapping> {
  const conv = await loadConversation(conversationId);
  return conv.mapping;
}
