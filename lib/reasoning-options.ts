/**
 * Единая точка отключения «размышлений» модели.
 *
 * Замер на стенде: чат-шаг сгенерировал 12 810 токенов ради ответа в 145
 * символов — почти всё ушло в скрытый reasoning облачной модели. На работе с
 * документом это минуты ожидания и упор в тайм-аут функции.
 *
 * Раньше опции ставились в четырёх местах по-разному и с разными условиями
 * (где-то только при анонимизации, где-то без `exclude`, а планировщик правок
 * не получал их вовсе). Теперь набор один и применяется ко всем вызовам,
 * связанным с документом.
 *
 * Ключ `openrouter` другие провайдеры игнорируют, поэтому опции можно передавать
 * безусловно — локальному Ollama они не мешают (там думание выключается
 * отдельно, через `think:false` в fetch-обёртке resolve-chat-model).
 */

export type ReasoningMode = 'off' | 'min';

/** Режим из env: off — выключить совсем (по умолчанию), min — минимальный бюджет. */
function mode(): ReasoningMode {
  return (process.env.OPENROUTER_REASONING ?? 'off').trim().toLowerCase() === 'min' ? 'min' : 'off';
}

/** Запасные слаги OpenRouter: список для авто-роутинга при отказе основного. */
function fallbackModels(): string[] {
  return (process.env.OPENROUTER_FALLBACK_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * providerOptions для любого вызова, связанного с документом: генерация,
 * повтор, планировщик точечных правок, проверка документа.
 *
 * `enabled: false` отключает reasoning там, где модель это умеет.
 * `exclude: true` нужен вдобавок: на моделях, где отключить нельзя, рассуждения
 * хотя бы не попадают в ответ и не ломают разбор JSON.
 * В режиме `min` вместо полного отключения ставим маленький бюджет — некоторые
 * модели с полностью выключенным reasoning отвечают заметно хуже.
 */
export function documentReasoningOptions(): Record<string, any> {
  const openrouter: Record<string, any> =
    mode() === 'min'
      ? { reasoning: { effort: 'low', exclude: true, max_tokens: 256 } }
      : { reasoning: { enabled: false, exclude: true } };

  const models = fallbackModels();
  if (models.length > 0) openrouter.models = models;

  return { openrouter };
}

/** Короткая сводка по фактическому расходу токенов — видно, слушается ли модель. */
export function formatUsage(usage: unknown): string {
  const u = (usage ?? {}) as Record<string, unknown>;
  const input = u.inputTokens ?? u.promptTokens;
  const output = u.outputTokens ?? u.completionTokens;
  const reasoning = u.reasoningTokens;
  return `in=${input ?? '?'} out=${output ?? '?'} reasoning=${reasoning ?? 0}`;
}
