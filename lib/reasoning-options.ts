/** Короткая сводка по фактическому расходу токенов — видно, слушается ли модель. */
export function formatUsage(usage: unknown): string {
  const u = (usage ?? {}) as Record<string, unknown>;
  const input = u.inputTokens ?? u.promptTokens;
  const output = u.outputTokens ?? u.completionTokens;
  const reasoning = u.reasoningTokens;
  return `in=${input ?? '?'} out=${output ?? '?'} reasoning=${reasoning ?? 0}`;
}
