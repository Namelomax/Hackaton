/**
 * Понимает ли эндпоинт вендорские поля Ollama (`think`, `keep_alive`).
 *
 * Зачем проверка: обычный OpenAI-совместимый шлюз на неизвестное поле в теле
 * отвечает 400, а не игнорирует его. Пока LLM жила в Ollama, поля можно было
 * слать всегда; после переезда на внешний API это ломает каждый запрос.
 *
 * Определяем по адресу, с возможностью переопределить:
 *   LLM_VENDOR_EXTENSIONS=ollama — слать всегда,
 *   LLM_VENDOR_EXTENSIONS=none  — не слать никогда.
 */
export function supportsOllamaExtensions(baseUrl?: string): boolean {
  const forced = process.env.LLM_VENDOR_EXTENSIONS?.trim().toLowerCase();
  if (forced === 'ollama') return true;
  if (forced === 'none') return false;

  const url = (baseUrl || process.env.OLLAMA_BASE_URL || '').toLowerCase();
  if (!url) return false;
  // Локальный Ollama, он же за JupyterHub-прокси (порты 11433/11434),
  // он же сервис `ollama` в compose.
  return /(:1143[34]\b)|(\/proxy\/1143[34])|(\bollama\b)/.test(url);
}

export function applyOllamaOpenAiCompatOptions(
  body: Record<string, unknown>,
  useThinking: boolean,
  baseUrl?: string,
): void {
  // reasoning_effort — часть спецификации OpenAI, его понимают и сторонние
  // шлюзы, поэтому шлём всегда. А `think` — вендорское поле Ollama.
  if (useThinking) {
    if (supportsOllamaExtensions(baseUrl)) body.think = true;
  } else {
    if (supportsOllamaExtensions(baseUrl)) body.think = false;
    body.reasoning_effort = 'none';
  }
}

/** Лимит токенов обычного ответа чата (один уточняющий вопрос / небольшой блок). */
export function ollamaChatMaxOutputTokens(): number {
  const n = Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 4096;
}

/** Короткий ответ после загрузки файла / уточняющий вопрос по разделу 1. */
export function ollamaFileTurnMaxOutputTokens(): number {
  const n = Number(process.env.OLLAMA_FILE_TURN_MAX_OUTPUT_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : 2048;
}

/**
 * НАСТОЯЩЕЕ окно модели на шлюзе — то, что отдаёт `max_model_len` в
 * GET $OLLAMA_BASE_URL/models. Это НЕ то же самое, что OLLAMA_CONTEXT_LENGTH:
 * та переменная — желаемый бюджет, и она вполне может врать.
 *
 * Реальный отказ (16.08.2026): в env стояло 65536, у qwen3.5-35b окно 32768.
 * Лимит вывода считался как 0.4 × 65536 = 26214, промпт занял 6555, сумма
 * 32769 — ровно на один токен больше окна. Шлюз ответил 400, пользователь
 * увидел бесконечный спиннер и пустую панель.
 *
 * Значение по умолчанию соответствует текущей модели. Меняете модель — меняйте
 * и эту переменную вместе с FIXED_CHAT_MODEL и ALLOWED_OLLAMA_MODELS.
 */
export function llmMaxModelLen(): number {
  const n = Number(process.env.LLM_MAX_MODEL_LEN);
  return Number.isFinite(n) && n > 0 ? n : 32768;
}

/**
 * Урезает max_tokens так, чтобы промпт и ответ вместе поместились в окно.
 *
 * Шлюз считает сумму `prompt_tokens + max_tokens` и отклоняет запрос целиком,
 * если она превышает окно хотя бы на единицу. Ошибка приходит ДО генерации,
 * поэтому ни стрима, ни текста пользователь не получает — только висящий
 * спиннер.
 *
 * promptChars → токены по той же оценке, что и везде в проекте (2.34 символа
 * на токен для русского), с запасом RESERVE на расхождение оценки с реальным
 * токенизатором.
 */
export function clampMaxTokensToWindow(
  promptChars: number,
  requestedMax: number,
): { max: number; clamped: boolean } {
  const window = llmMaxModelLen();
  const RESERVE = 512;
  const promptTokens = Math.ceil(promptChars / 2.34);
  const room = window - promptTokens - RESERVE;
  // Меньше 256 токенов на ответ — запрос всё равно бессмыслен; отдаём этот
  // минимум и пусть шлюз ответит внятной ошибкой про длину промпта, а не мы
  // молча пришлём max_tokens=0.
  const allowed = Math.max(256, room);
  if (requestedMax <= allowed) return { max: requestedMax, clamped: false };
  return { max: allowed, clamped: true };
}

/**
 * Полный JSON протокола может быть объёмным — отдельный, больший лимит.
 * 8192 не хватало: у qwen3 это общий бюджет на размышления и JSON, длинный
 * протокол обрывался на середине. Держим тот же запас, что и в облаке.
 */
export function ollamaProtocolMaxOutputTokens(): number {
  const explicit = Number(process.env.OLLAMA_PROTOCOL_MAX_OUTPUT_TOKENS);
  const desired = Number.isFinite(explicit) && explicit > 0 ? explicit : 32000;
  // Страховка от узкого num_ctx: если под ответ уйдёт слишком много окна,
  // Ollama МОЛЧА отрежет начало промпта вместе с системными инструкциями.
  // Оставляем минимум 60% окна под промпт.
  const ctx = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  if (Number.isFinite(ctx) && ctx > 0) {
    return Math.max(8192, Math.min(desired, Math.floor(ctx * 0.4)));
  }
  return desired;
}

/**
 * Потолок вывода для генерации протокола ОБЛАЧНОЙ моделью.
 *
 * Раньше сюда шёл ollamaProtocolMaxOutputTokens() = 8192. Для reasoning-модели
 * это общий бюджет на размышления + JSON: рассуждения съедали его целиком, и
 * ответ приходил пустым (text='', finishReason='other' → AI_NoObjectGeneratedError).
 * У облачных моделей окно вывода несопоставимо больше — держим запас.
 */
export function cloudProtocolMaxOutputTokens(): number {
  const n = Number(process.env.CLOUD_PROTOCOL_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(n) && n > 0) return n;
  return 32000;
}

/**
 * Глобальный жёсткий потолок max_tokens на стороне fetch-обёртки.
 * Это НЕ дефолт ответа, а предохранитель: не даёт ни одному запросу попросить
 * абсурдно много. Должен быть ≥ ollamaProtocolMaxOutputTokens(), иначе бюджет
 * протокола молча срежется здесь (было 16384 при протоколе 32000).
 */
export function ollamaHardCapOutputTokens(): number {
  const n = Number(process.env.OLLAMA_HARD_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(n) && n > 0) return Math.max(n, ollamaProtocolMaxOutputTokens());
  return Math.max(32768, ollamaProtocolMaxOutputTokens());
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
