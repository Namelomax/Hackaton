/**
 * Типы слоя анонимизации.
 *
 * Mapping — словарь `placeholder -> оригинал`, например
 * `{"[PERSON_1]": "Иванов Иван", "[ORG_1]": "ООО «Чебурашка»"}`.
 * Это «ключ» деанонимизации, хранится отдельно от анонимного текста
 * (per-conversation в SurrealDB).
 */
export type Mapping = Record<string, string>;

/** Счётчики последнего использованного номера по каждой метке (PERSON, ORG, …). */
export type LabelCounters = Record<string, number>;

/** Канонический маппинг диалога: прямой словарь + счётчики номеров. */
export interface ConversationMapping {
  mapping: Mapping;
  counters: LabelCounters;
}

/** Ответ удалённого Python-сервиса /anonymize. */
export interface RemoteAnonymizeResult {
  anonymized_text: string;
  mapping: Mapping;
  summary: Record<string, number>;
  spans: { start: number; end: number; label: string; text: string }[];
  stages?: Record<string, boolean>;
}

/** Результат канонической анонимизации одного текста. */
export interface AnonymizeMergeResult {
  /** Текст с КАНОНИЧЕСКИМИ плейсхолдерами диалога. */
  anonymizedText: string;
  /** Обновлённый канонический маппинг диалога. */
  conversation: ConversationMapping;
  /** Сколько новых сущностей добавлено в этот раз. */
  added: number;
}
