import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { FIXED_CHAT_MODEL, parseAllowedOllamaModelsFromServerEnv } from '@/lib/chat-models';
import { applyOllamaOpenAiCompatOptions, ollamaChatMaxOutputTokens } from '@/lib/ollama-limits';

export type ChatProviderId = 'ollama' | 'openrouter';

export type ResolveChatModelOptions = {
  chatProvider?: ChatProviderId | string;
  chatModel?: string;
  useThinking?: boolean;
};

function createOpenRouterInstance() {
  return createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    baseURL: 'https://openrouter.ai/api/v1',
    compatibility: 'strict',
    headers: {
      'X-Title': 'AISDK',
    },
  });
}

function resolveOpenRouterSlug(requestedRaw: string): string {
  const fallback = process.env.OPENROUTER_MODEL_DEFAULT || 'nvidia/nemotron-3-super-120b-a12b:free';
  const requested = requestedRaw.trim();
  const allowedCsv = process.env.ALLOWED_OPENROUTER_MODELS?.trim();
  if (!allowedCsv) {
    if (requested && /^[\w\-./:]+$/.test(requested) && requested.length <= 160) return requested;
    return fallback;
  }
  const allowed = allowedCsv.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(requested)) return requested;
  return allowed.includes(fallback) ? fallback : allowed[0]!;
}

/** Та же логика выбора модели, что и в /api/chat — Ollama или OpenRouter. */
export function resolveChatLanguageModel(options: ResolveChatModelOptions = {}) {
  const provider: ChatProviderId = options.chatProvider === 'openrouter' ? 'openrouter' : 'ollama';

  if (provider === 'ollama') {
    const allowed = parseAllowedOllamaModelsFromServerEnv(process.env.ALLOWED_OLLAMA_MODELS);
    const modelId = allowed.includes(FIXED_CHAT_MODEL)
      ? FIXED_CHAT_MODEL
      : allowed[0]!;
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
    const openai = createOpenAI({
      baseURL,
      apiKey: process.env.OLLAMA_API_KEY || 'ollama',
      fetch: async (url, init) => {
        if (init?.body && typeof init.body === 'string') {
          try {
            const parsed = JSON.parse(init.body) as Record<string, unknown>;
            applyOllamaOpenAiCompatOptions(parsed, Boolean(options.useThinking));
            const cap = ollamaChatMaxOutputTokens();
            const requestedMax =
              typeof parsed.max_tokens === 'number' ? parsed.max_tokens : cap;
            parsed.max_tokens = Math.min(requestedMax, cap);
            return fetch(url, { ...init, body: JSON.stringify(parsed) });
          } catch {
            /* fallthrough */
          }
        }
        return fetch(url, init ?? {});
      },
    });
    return openai.chat(modelId);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  const slug = resolveOpenRouterSlug(typeof options.chatModel === 'string' ? options.chatModel : '');
  return createOpenRouterInstance().chat(slug);
}
