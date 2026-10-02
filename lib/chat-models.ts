/**
 * Единственная модель чата (пока без выбора в UI).
 *
 * ВАЖНО: это же значение — дефолт, когда ALLOWED_OLLAMA_MODELS не задан в env
 * (см. parseAllowedOllamaModelsFromServerEnv). Значение здесь и значение в env
 * ОБЯЗАНЫ совпадать: если они разойдутся, инстанс без переменной поднимет
 * другую модель, и на общей карте окажутся загружены две сразу → OOM. Именно
 * это уже случалось, когда тут стоял qwen, а в env — gemma.
 *
 * ЭТО ТЕПЕРЬ ТОЛЬКО ФОЛБЭК. Актуальное имя приложение узнаёт само у шлюза
 * (lib/gateway-model.ts, GET {OLLAMA_BASE_URL}/models) и подхватывает смену на
 * лету: при `404 ... does not exist` перезапрашивает список, подставляет новое
 * имя и повторяет запрос один раз. Константа нужна лишь на холодном старте,
 * пока кэш обнаружения пуст, и когда обнаружение выключено
 * (GATEWAY_MODEL_DISCOVERY=off).
 *
 * Почему так: администраторы шлюза меняют выложенную модель молча, и до
 * появления авто-обнаружения каждая замена роняла ВСЁ до ручной правки этой
 * строки. Хроника: gemma-4-31b → qwen3.5-35b (14.08.2026) →
 * qwen3.8-27B (26.08.2026) → Qwen3.8-27b-U (08.09.2026).
 *
 * Держать значение в актуальном состоянии по-прежнему полезно — тогда даже
 * первый запрос после рестарта уходит без лишнего 404. Проверять так, имя
 * обязано совпадать символ в символ (регистр значим):
 *   curl -s "$OLLAMA_BASE_URL/models" -H "Authorization: Bearer $OLLAMA_API_KEY"
 *
 * Оттуда же берётся max_model_len — его читает llmMaxModelLen()
 * (lib/ollama-limits.ts). Бюджет контекста задаётся в OLLAMA_CONTEXT_LENGTH,
 * LLM_MAX_MODEL_LEN и в effectiveOllamaContextTokens() (app/api/chat/route.ts):
 * если оставить больше, чем держит модель, шлюз молча отрежет НАЧАЛО промпта,
 * то есть системные правила регламента.
 */
export const FIXED_CHAT_MODEL = 'Qwen3.8-27b-U';

/**
 * Разрешённые модели «локального» провайдера. Кавычки не случайны: с переездом
 * на внешний шлюз (OLLAMA_BASE_URL указывает на него) провайдер остался
 * OpenAI-совместимым, а вот идентификаторы моделей теперь в стиле шлюза
 * (`Qwen3.8-27b-U`), а не тегов Ollama (`qwen3.8:27b`). Имя должно совпадать с
 * тем, что отдаёт GET {BASE_URL}/models, символ в символ — включая регистр.
 */
export const DEFAULT_LOCAL_CHAT_MODELS = ['Qwen3.8-27b-U'] as const;

/** Короткие подписи для селектора моделей в UI */
export const LOCAL_MODEL_LABELS: Record<string, string> = {
  'Qwen3.8-27b-U': 'Qwen3.8 27B',
};

export function parseModelsFromEnv(jsonEnv?: string): string[] {
  const raw = jsonEnv?.trim();
  if (!raw) return [...DEFAULT_LOCAL_CHAT_MODELS];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_LOCAL_CHAT_MODELS];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [...DEFAULT_LOCAL_CHAT_MODELS];
  }
}

/** Модель по умолчанию для чата: FIXED_CHAT_MODEL (селектора в UI нет). */
export function pickDefaultLocalChatModel(_jsonEnv?: string): string {
  return FIXED_CHAT_MODEL;
}

export function parseAllowedOllamaModelsFromServerEnv(csv?: string): string[] {
  const raw = csv?.trim();
  if (!raw) return [...DEFAULT_LOCAL_CHAT_MODELS];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_LOCAL_CHAT_MODELS];
}
