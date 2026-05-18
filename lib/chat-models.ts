/** Allowed local chat models (must match `ollama list` names). */
export const DEFAULT_LOCAL_CHAT_MODELS = ['qwen3:14b', 'qwen3.5:9b'] as const;

/** Короткие подписи для селектора моделей в UI */
export const LOCAL_MODEL_LABELS: Record<string, string> = {
  'qwen3:14b': 'Qwen3 14B',
  'qwen3.5:9b': 'Qwen3.5 9B',
};

/** Available OpenRouter cloud models (optional admin UI / env). */
export const OPENROUTER_MODELS: { id: string; label: string }[] = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 120B (free)' },
  { id: 'openrouter/owl-alpha', label: 'Owl Alpha' },
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

/** Предпочитает локальную модель с «14b» в имени (например qwen3:14b), иначе первую из списка. */
export function pickDefaultLocalChatModel(jsonEnv?: string): string {
  const list = parseModelsFromEnv(jsonEnv);
  return list.find((m) => /14b/i.test(m)) ?? list[0] ?? 'qwen3:14b';
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
