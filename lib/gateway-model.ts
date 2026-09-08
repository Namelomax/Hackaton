import { insecureFetch } from '@/lib/insecure-fetch';
import { FIXED_CHAT_MODEL, parseAllowedOllamaModelsFromServerEnv } from '@/lib/chat-models';

/**
 * Обнаружение реальной модели на «локальном» шлюзе (внешний OpenAI-совместимый
 * vLLM за OLLAMA_BASE_URL, не Ollama) вместо жёстко зашитого FIXED_CHAT_MODEL.
 *
 * История отказа: администраторы шлюза трижды за месяц молча меняли
 * выложенную модель (gemma-4-31b → qwen3.5-35b → qwen3.8-27B), и каждый раз
 * КАЖДЫЙ запрос падал с `404 The model <старое имя> does not exist` — и
 * локальный режим, и LLM-слой анонимизатора (он тоже ходит через
 * OLLAMA_BASE_URL), пока кто-то вручную не правил FIXED_CHAT_MODEL в коде.
 *
 * GET {OLLAMA_BASE_URL}/models отдаёт актуальный id и max_model_len — читаем
 * оттуда сами. Пример реального ответа шлюза (проверено 08.09.2026):
 *   {"object":"list","data":[{"id":"qwen3.8-27B","max_model_len":32768,
 *     "permission":[{"id":"modelperm-b3feba60fae781e2", ...}]}]}
 *
 * ВАЖНО: у вложенных объектов permission[] тоже есть поле id
 * (`modelperm-*`) — берём id ТОЛЬКО из data[], без рекурсивного поиска,
 * иначе можно случайно подхватить modelperm-строку вместо имени модели.
 */

export type GatewayModelInfo = { id: string; maxModelLen: number | null };

type CacheState = {
  value: GatewayModelInfo | null;
  fetchedAt: number;
};

/** last-known-good переживает неудачную перепроверку — не затираем на null. */
let cache: CacheState = { value: null, fetchedAt: 0 };

/** Дедупликация параллельных вызовов discoverGatewayModel(). */
let inFlight: Promise<GatewayModelInfo | null> | null = null;

function ttlMs(): number {
  const n = Number(process.env.GATEWAY_MODEL_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

function discoveryDisabled(): boolean {
  return (process.env.GATEWAY_MODEL_DISCOVERY ?? '').trim().toLowerCase() === 'off';
}

/**
 * Стабильность важнее новизны: если в списке шлюза уже есть модель, которую
 * мы и так используем (FIXED_CHAT_MODEL) или явно разрешили (ALLOWED_OLLAMA_MODELS),
 * берём её. Иначе — первый элемент data[], раз шлюз выложил что-то новое.
 */
function pickModelId(ids: string[]): string {
  if (ids.includes(FIXED_CHAT_MODEL)) return FIXED_CHAT_MODEL;
  const allowed = parseAllowedOllamaModelsFromServerEnv(process.env.ALLOWED_OLLAMA_MODELS);
  const fromAllowed = allowed.find((m) => ids.includes(m));
  if (fromAllowed) return fromAllowed;
  return ids[0]!;
}

type GatewayModelsResponseEntry = {
  id?: unknown;
  max_model_len?: unknown;
};

async function fetchGatewayModels(): Promise<GatewayModelInfo | null> {
  const baseURL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
  const apiKey = process.env.OLLAMA_API_KEY || 'ollama';
  const url = `${baseURL.replace(/\/+$/, '')}/models`;

  const resp = await insecureFetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`GET ${url} → ${resp.status}`);
  }

  const json = (await resp.json()) as { data?: GatewayModelsResponseEntry[] };
  const entries = Array.isArray(json.data) ? json.data : [];
  // Только data[].id — НЕ рекурсивный поиск, иначе подхватится modelperm-*
  // из вложенного permission[] (см. комментарий вверху файла).
  const ids = entries
    .map((e) => (typeof e.id === 'string' && e.id ? e.id : null))
    .filter((x): x is string => x !== null);
  if (ids.length === 0) return null;

  const id = pickModelId(ids);
  const matched = entries.find((e) => e.id === id);
  const maxModelLen =
    typeof matched?.max_model_len === 'number' && Number.isFinite(matched.max_model_len)
      ? matched.max_model_len
      : null;

  return { id, maxModelLen };
}

/**
 * Обнаруживает текущую модель шлюза. По умолчанию не блокирует счастливый
 * путь: холодный старт использует фолбэк-константу FIXED_CHAT_MODEL, а
 * обнаружение подхватывается на следующем запросе (кэш) или на 404-ретрае
 * (force=true).
 *
 * Никогда не бросает наружу — любая ошибка сети/парсинга возвращает null.
 */
export async function discoverGatewayModel(force = false): Promise<GatewayModelInfo | null> {
  if (discoveryDisabled()) return null;

  const now = Date.now();
  if (!force && cache.value && now - cache.fetchedAt < ttlMs()) {
    return cache.value;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await fetchGatewayModels();
      if (result) {
        cache = { value: result, fetchedAt: Date.now() };
      }
      return result;
    } catch (err) {
      console.warn(
        `[gateway-model] обнаружение модели шлюза не удалось: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Синхронный доступ к последнему успешно обнаруженному значению (может быть null). */
export function getCachedGatewayModel(): GatewayModelInfo | null {
  return cache.value;
}
