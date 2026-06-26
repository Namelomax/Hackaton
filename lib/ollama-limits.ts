/**
 * Параметры thinking для OpenAI-совместимого `/v1/chat/completions` Ollama.
 * `think: false` на этом эндпоинте часто не отключает reasoning (весь ответ в `reasoning`, content пустой).
 * Рабочий вариант: `reasoning_effort: "none"` (см. docs.ollama.com/api/openai-compatibility).
 */
export function applyOllamaOpenAiCompatOptions(
  body: Record<string, unknown>,
  useThinking: boolean,
): void {
  if (useThinking) {
    body.think = true;
  } else {
    body.think = false;
  }
}

/** Лимит токенов ответа чата (streamText → max_tokens в Ollama). */
export function ollamaChatMaxOutputTokens(): number {
  const n = Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 327680;
}

/** Короткий ответ после загрузки файла / уточняющий вопрос по разделу 1. */
export function ollamaFileTurnMaxOutputTokens(): number {
  const n = Number(process.env.OLLAMA_FILE_TURN_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 204800;
}

export function ollamaProtocolMaxOutputTokens(): number {
  const protocol = Number(process.env.OLLAMA_PROTOCOL_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(protocol) && protocol > 0) return protocol;
  return ollamaChatMaxOutputTokens();
}

export function pickChatMaxOutputTokens(options: {
  hasInlineTranscript: boolean;
  dialogMessageCount: number;
  protocolShortReply?: boolean;
}): number {
  if (options.protocolShortReply) return ollamaFileTurnMaxOutputTokens();
  const earlyDialog =
    options.hasInlineTranscript && options.dialogMessageCount <= 4;
  if (earlyDialog) return ollamaFileTurnMaxOutputTokens();
  return ollamaChatMaxOutputTokens();
}

/** Интервал heartbeat в логах web во время стрима (мс). */
export function ollamaStreamHeartbeatMs(inlineDoc?: boolean): number {
  const n = Number(process.env.OLLAMA_STREAM_HEARTBEAT_MS);
  const base = Number.isFinite(n) && n >= 3000 ? n : 15000;
  if (inlineDoc) return Math.min(base, 5000);
  return base;
}

/**
 * Количество параллельных запросов к Ollama.
 * Читается из OLLAMA_NUM_PARALLEL (задаётся на стороне Ollama-сервера).
 * Эта функция только для логирования и диагностики — сам Ollama читает переменную напрямую.
 */
export function ollamaNumParallel(): number {
  const n = Number(process.env.OLLAMA_NUM_PARALLEL);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
