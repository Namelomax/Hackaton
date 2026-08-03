/**
 * Единственная модель чата (пока без выбора в UI).
 *
 * ВАЖНО: это же значение — дефолт, когда ALLOWED_OLLAMA_MODELS не задан в env
 * (см. parseAllowedOllamaModelsFromServerEnv). Значение здесь и значение в env
 * ОБЯЗАНЫ совпадать: если они разойдутся, инстанс без переменной поднимет
 * другую модель, и на общей карте окажутся загружены две сразу → OOM. Именно
 * это уже случалось, когда тут стоял qwen, а в env — gemma.
 *
 * Сейчас qwen3.5:9b: gemma4:12b в Q4 занимает 6.86 ГБ и на 10-гигабайтной карте
 * (RTX 3080, ~7 ГБ свободных под модель) грузилась лишь частично —
 * `offloaded 34/49 layers`, 2.7 ГБ весов оставались на CPU. Отсюда 18 ток/с
 * генерации и провалы prompt eval до 27 ток/с при промахе кэша. 9B помещается
 * в карту целиком.
 *
 * После смены модели проверьте в логе Ollama строку `load_tensors: offloaded
 * N/M layers to GPU` — N должно равняться M. Если нет, уменьшайте
 * OLLAMA_CONTEXT_LENGTH (KV-кэш ест VRAM линейно по контексту) или снимайте
 * GLiNER с видеокарты: `server.py --device cpu`.
 */
export const FIXED_CHAT_MODEL = 'qwen3.5:9b';

/** Allowed local chat models (must match `ollama list` names). */
export const DEFAULT_LOCAL_CHAT_MODELS = ['qwen3.5:9b'] as const;

/** Короткие подписи для селектора моделей в UI */
export const LOCAL_MODEL_LABELS: Record<string, string> = {
  'gemma4:12b': 'Gemma 4 12B',
  'qwen3:14b': 'Qwen3 14B',
  'qwen3.5:9b': 'Qwen3.5 9B',
};

/**
 * Облачная модель по умолчанию (режим «Облако + анонимизация»).
 * Сервер может переопределить через ANONYMIZER_CLOUD_MODEL / OPENROUTER_MODEL_DEFAULT.
 */
export const DEFAULT_CLOUD_CHAT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';

/**
 * Отключённые/мёртвые слаги OpenRouter (404 «No endpoints found»). Могут
 * прилетать из устаревшего env на деплое или из старого клиентского бандла
 * (незакрытая вкладка) — молча заменяем на DEFAULT_CLOUD_CHAT_MODEL.
 */
const DEAD_CLOUD_MODELS = new Set(['openrouter/owl-alpha']);

/** Нормализует слаг облачной модели: пустой или мёртвый → дефолтный. */
export function normalizeCloudModel(id?: string | null): string {
  const slug = (id ?? '').trim();
  if (!slug || DEAD_CLOUD_MODELS.has(slug)) return DEFAULT_CLOUD_CHAT_MODEL;
  return slug;
}

/** Available OpenRouter cloud models (optional admin UI / env). */
export const OPENROUTER_MODELS: { id: string; label: string }[] = [
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron Ultra 550B (free)' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 120B (free)' },
  { id: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro' },
  { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
];

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

/** Модель по умолчанию для чата: gemma4:12b, иначе первая из списка env. */
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
