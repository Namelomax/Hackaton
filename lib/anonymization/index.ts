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
import {
  anonymizeRemote,
  AnonymizerUnavailableError,
  fetchAnonymizeJob,
  submitAnonymizeJob,
} from './remote-client';
import {
  applyMappingForward,
  applyMappingForwardDeep,
  countersFromMapping,
  mergeRemoteResult,
} from './merge';
import { scrubStructured, scrubSensitiveOrgs, restoreNonSensitivePlaceholders } from './scrub';
import { deanonymize, deepDeanonymize } from './deanonymize';
import type { ConversationMapping, Mapping } from './types';

export { AnonymizerUnavailableError };
export { deanonymize, deepDeanonymize };
export { applyMappingForward, applyMappingForwardDeep, countersFromMapping };
export { scrubStructured, scrubSensitiveOrgs, restoreNonSensitivePlaceholders };
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
 * Старт анонимизации в фоне: ставим задачу на сервере и сразу отдаём её id.
 *
 * Возвращает:
 *   {kind:'job', jobId}   — задача принята, опрашивать `completeAnonymizeJob`;
 *   {kind:'done', result} — работы не было (пустой текст) либо сервер старой
 *                           версии без /jobs и мы отработали синхронно.
 *
 * Смысл разделения на старт и завершение — в том, чтобы НИ ОДИН HTTP-запрос
 * не жил дольше пары секунд: и релей туннеля, и Vercel ограничивают именно
 * длительность одного запроса, а не общее время работы.
 */
export type AnonymizeStart =
  | { kind: 'job'; jobId: string }
  | { kind: 'done'; result: AnonymizeTextResult };

export async function startAnonymizeJob(
  text: string,
  conversationId?: string | null,
): Promise<AnonymizeStart> {
  if (!text || !text.trim()) {
    const conv = await loadConversation(conversationId);
    return {
      kind: 'done',
      result: { anonymizedText: text, mapping: conv.mapping, added: 0, summary: {} },
    };
  }

  const jobId = await submitAnonymizeJob(text);
  if (jobId) return { kind: 'job', jobId };

  // Анонимизатор без job-API — отрабатываем по-старому, одним запросом.
  return { kind: 'done', result: await anonymizeNewText(text, conversationId) };
}

/**
 * Один опрос фоновой задачи. Пока не готово — {done:false}. Когда готово,
 * вливаем результат в канонический mapping диалога и сохраняем: слияние
 * происходит ровно один раз, в момент завершения, а не на каждом опросе.
 */
export async function completeAnonymizeJob(
  jobId: string,
  conversationId?: string | null,
): Promise<{ done: false } | { done: true; result: AnonymizeTextResult }> {
  const state = await fetchAnonymizeJob(jobId);
  if (state.status !== 'done') return { done: false };

  const conv = await loadConversation(conversationId);
  const merged = mergeRemoteResult(conv, state.result);

  if (conversationId && merged.added > 0) {
    await saveConversationMapping(conversationId, merged.conversation);
  }

  return {
    done: true,
    result: {
      anonymizedText: merged.anonymizedText,
      mapping: merged.conversation.mapping,
      added: merged.added,
      summary: state.result.summary ?? {},
    },
  };
}

/**
 * Быстрая локальная анонимизация по уже известному mapping (без вызова сервера).
 * Для документа/истории на повторных ходах диалога.
 *
 * Использует «глубокую» подстановку: помимо полных оригиналов подставляет и
 * отдельные компоненты ФИО, чтобы одиночное имя (напр. «Никита») не утекло в
 * облако, если серверный NER пометил только полное «Никита Грицанюк».
 */
export function anonymizeWithMapping(text: string, mapping: Mapping): string {
  return applyMappingForwardDeep(text, mapping);
}

/** Загрузить только mapping диалога (для деанонимизации ответа). */
export async function loadConversationMapping(
  conversationId?: string | null,
): Promise<Mapping> {
  const conv = await loadConversation(conversationId);
  return conv.mapping;
}

/** Сохранить канонический mapping диалога (mapping + counters). */
export async function persistConversationMapping(
  conversationId: string | null | undefined,
  conv: ConversationMapping,
): Promise<void> {
  if (!conversationId) return;
  await saveConversationMapping(conversationId, {
    mapping: conv.mapping,
    counters: conv.counters,
  });
}
