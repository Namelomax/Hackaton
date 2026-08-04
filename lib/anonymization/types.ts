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

/**
 * Фрагмент, который не удалось проверить через GLiNER.
 *
 * Один упавший кусок НЕ роняет весь документ: остальные куски анонимизируются
 * штатно, а про этот честно сообщается наверх. Молча продолжать нельзя — в
 * непроверенном фрагменте могли остаться ПДн, и пользователь должен решить,
 * отправлять ли документ в облако.
 */
export interface AnonymizeWarning {
  kind: 'gliner_chunk_failed';
  /** Смещение фрагмента в исходном тексте. */
  offset: number;
  /** Длина фрагмента в символах. */
  chars: number;
  message: string;
}

/** Ответ удалённого Python-сервиса /anonymize или локального GLiNER-пайплайна. */
export interface RemoteAnonymizeResult {
  anonymized_text: string;
  mapping: Mapping;
  summary: Record<string, number>;
  spans: { start: number; end: number; label: string; text: string }[];
  stages?: Record<string, boolean>;
  warnings?: AnonymizeWarning[];
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
