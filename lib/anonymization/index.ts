/**
 * Оркестрация анонимизации на уровне диалога.
 *
 * Главный принцип скорости: удалённый сервер (20–30 c на документ) дёргаем
 * ТОЛЬКО для нового текста. Уже известные значения подставляем локально и
 * детерминированно по каноническому mapping диалога (`applyMappingForward`).
 */
import { getConversationMapping, saveConversationMapping } from '@/lib/getPromt';
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
import { scrubStructured, scrubSensitiveOrgs, restoreNonSensitivePlaceholders, dropNonSensitiveEntries, isGenericEntityValue } from './scrub';
import { deanonymize, deepDeanonymize } from './deanonymize';
import { mergeAliases } from './merge-inflected';
import type { AnonymizeWarning, ConversationMapping, Mapping, PlaceholderAlias } from './types';

export { AnonymizerUnavailableError };
export { deanonymize, deepDeanonymize };
export { applyMappingForward, applyMappingForwardDeep, countersFromMapping };
export { scrubStructured, scrubSensitiveOrgs, restoreNonSensitivePlaceholders, dropNonSensitiveEntries, isGenericEntityValue };
export type { Mapping, ConversationMapping, PlaceholderAlias };

/**
 * Повторяет fn до maxAttempts раз при AnonymizerUnavailableError.
 * Другие ошибки пробрасываются сразу. Задержка растёт линейно (baseDelayMs * attempt).
 */
async function withAnonymizerRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 3000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof AnonymizerUnavailableError) || attempt === maxAttempts) throw e;
      const delay = baseDelayMs * attempt;
      console.warn(
        `[anonymize] попытка ${attempt}/${maxAttempts} не удалась, повтор через ${delay / 1000}с: ` +
          (e instanceof Error ? e.message.slice(0, 120) : String(e)),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // unreachable
  throw new AnonymizerUnavailableError('все попытки исчерпаны');
}

async function loadConversation(conversationId?: string | null): Promise<ConversationMapping> {
  if (!conversationId) return { mapping: {}, counters: {}, aliases: [] };
  const stored = await getConversationMapping(conversationId);
  const counters =
    stored.counters && Object.keys(stored.counters).length > 0
      ? stored.counters
      : countersFromMapping(stored.mapping ?? {});
  return {
    mapping: stored.mapping ?? {},
    counters,
    // Алиасы, чей плейсхолдер уже исчез из mapping, отбрасываем при чтении.
    aliases: mergeAliases(stored.aliases, [], stored.mapping ?? {}),
  };
}

/** Загрузить mapping + алиасы диалога (для анонимизации и деанонимизации). */
export async function loadConversationState(
  conversationId?: string | null,
): Promise<ConversationMapping> {
  return loadConversation(conversationId);
}

export interface AnonymizeTextResult {
  anonymizedText: string;
  mapping: Mapping;
  /** Подтверждённые склонённые формы известных значений (см. PlaceholderAlias). */
  aliases: PlaceholderAlias[];
  added: number;
  summary: Record<string, number>;
  /**
   * Фрагменты, которые не удалось проверить. Пустой массив — норма; непустой
   * означает, что часть текста ушла дальше НЕпроверенной, и это нужно показать
   * пользователю до отправки в облако.
   */
  warnings?: AnonymizeWarning[];
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
    return {
      anonymizedText: text,
      mapping: conv.mapping,
      aliases: conv.aliases ?? [],
      added: 0,
      summary: {},
    };
  }

  const remote = await withAnonymizerRetry(() => anonymizeRemote(text));
  const merged = mergeRemoteResult(conv, remote);

  // Сервис анонимизации общий, его настройки нам не подчиняются: он маскирует
  // даты («Вчера», «следующей неделе», тайм-коды) и родовые слова («заказчик»,
  // «учреждение»). И то и другое не ПДн, а в документе оборачивается
  // «организация учреждение» и «Срок: следующей неделе». Чистим у себя: и
  // текст, и сам mapping — иначе плейсхолдеры всплывут при деанонимизации.
  const cleaned = dropNonSensitiveEntries(merged.anonymizedText, merged.conversation.mapping);
  if (cleaned.dropped.length > 0) {
    console.log(`🧹 не маскируем (не ПДн): ${cleaned.dropped.join(', ')}`);
  }
  const conversationOut =
    cleaned.dropped.length > 0
      ? { ...merged.conversation, mapping: cleaned.mapping }
      : merged.conversation;

  if (conversationId && merged.added > 0) {
    await persistConversationMapping(conversationId, conversationOut);
  }

  return {
    anonymizedText: cleaned.text,
    mapping: conversationOut.mapping,
    aliases: conversationOut.aliases ?? [],
    added: merged.added,
    summary: remote.summary ?? {},
    ...(remote.warnings?.length ? { warnings: remote.warnings } : {}),
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
      result: {
        anonymizedText: text,
        mapping: conv.mapping,
        aliases: conv.aliases ?? [],
        added: 0,
        summary: {},
      },
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
    await persistConversationMapping(conversationId, merged.conversation);
  }

  return {
    done: true,
    result: {
      anonymizedText: merged.anonymizedText,
      mapping: merged.conversation.mapping,
      aliases: merged.conversation.aliases ?? [],
      added: merged.added,
      summary: state.result.summary ?? {},
      ...(state.result.warnings?.length ? { warnings: state.result.warnings } : {}),
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
export function anonymizeWithMapping(
  text: string,
  mapping: Mapping,
  aliases: PlaceholderAlias[] = [],
): string {
  return applyMappingForwardDeep(text, mapping, aliases);
}

/** Загрузить только mapping диалога (для деанонимизации ответа). */
export async function loadConversationMapping(
  conversationId?: string | null,
): Promise<Mapping> {
  const conv = await loadConversation(conversationId);
  return conv.mapping;
}

/** Сохранить канонический mapping диалога (mapping + counters + алиасы). */
export async function persistConversationMapping(
  conversationId: string | null | undefined,
  conv: ConversationMapping,
): Promise<void> {
  if (!conversationId) return;
  await saveConversationMapping(conversationId, {
    mapping: conv.mapping,
    counters: conv.counters,
    aliases: mergeAliases(conv.aliases, [], conv.mapping),
  });
}
