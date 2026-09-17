/**
 * Разбор и формулировка сообщений об ошибках генерации протокола (AI SDK
 * `AI_NoObjectGeneratedError` и подобные). Вынесено отдельно от
 * document-agent.ts, чтобы юнит-тесты не тянули серверные импорты агента.
 */

export type GenerationFailureInfo = {
  finishReason: unknown;
  inputTokens: number | null;
};

/**
 * Достаёт finishReason и inputTokens из ошибки AI SDK. Та же логика, что
 * использует logGenerationFailure() в document-agent.ts для лога — вынесена
 * сюда, чтобы её же переиспользовать при выборе текста ошибки для пользователя.
 *
 * Никогда не бросает — на неожиданной форме объекта возвращает null-поля.
 */
export function extractGenerationFailureInfo(err: unknown): GenerationFailureInfo {
  const e = err as any;
  const usage = e?.usage ?? {};
  const inputTokensRaw = usage?.inputTokens ?? usage?.promptTokens;
  const inputTokens =
    typeof inputTokensRaw === 'number' && Number.isFinite(inputTokensRaw) ? inputTokensRaw : null;
  return {
    finishReason: e?.finishReason,
    inputTokens,
  };
}

/**
 * Сообщение пользователю, когда обе попытки генерации протокола (основная +
 * retryProtocolGeneration) не вернули JSON.
 *
 * Инцидент 17.09.2026: пустой кэш окна модели → фолбэк 32768 вместо реальных
 * 65536 → max_tokens урезан до 256 → JSON оборван на середине, а пользователь
 * видел «перегрузка или лимит бесплатного слага» — неправду. Если
 * finishReason === 'length', причина известна точно: промпт с ответом не
 * поместились в окно модели — говорим об этом прямо, с цифрами.
 */
export function buildGenerationFailureMessage(
  info: GenerationFailureInfo,
  windowSize: number,
): string {
  if (info.finishReason === 'length') {
    const promptPart =
      info.inputTokens != null
        ? `промпт занял ~${info.inputTokens} токенов при окне модели ${windowSize}`
        : `окно модели ${windowSize} токенов не вместило промпт и ответ целиком`;
    return `Расшифровка слишком большая: ${promptPart}, на протокол не осталось места. Сократите расшифровку или разбейте её на части.`;
  }
  return (
    'Модель дважды вернула пустой ответ при сборке протокола (перегрузка или лимит бесплатного слага). ' +
    'Повторите генерацию через минуту.'
  );
}
