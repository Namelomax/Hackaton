/** Allowed local chat models (must match `ollama list` names). */
export const DEFAULT_LOCAL_CHAT_MODELS = ['qwen3:14b', 'qwen3.6:27b'] as const;

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
