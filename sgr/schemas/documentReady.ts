import { z } from 'zod';

/**
 * Схема SGR для проверки готовности к генерации документа
 * Решает проблему 9 (не сразу начал генерацию)
 */
export const DocumentReadySchema = z.object({
  inputAnalysis: z.object({
    conversationHistory: z.array(z.string()),
    confirmedSections: z.array(z.string()),
  }),

  reasoning_steps: z.array(z.string()).describe(`
    Шаг 1: Определить, какие из 10 разделов заполнены
    Шаг 2: Проверить, какие разделы подтверждены пользователем
    Шаг 3: Оценить, были ли запросы на формирование документа
    Шаг 4: Определить готовность к генерации
    Шаг 5: Проверить, что ВСЕ 10 разделов заполнены
  `),

  output: z.object({
    filledSections: z.array(z.string()).describe('Список заполненных разделов (максимум 10)'),
    pendingSections: z.array(z.string()).describe('Список незаполненных разделов'),
    userRequestedDocument: z.boolean().describe('Запрашивал ли пользователь документ явно'),
    readyForGeneration: z.boolean().describe('Готов ли документ к генерации (ТОЛЬКО если все 10 разделов заполнены)'),
    suggestedAction: z.enum([
      'continue_filling',
      'ask_confirmation',
      'generate_document',
    ]).describe('continue_filling — если есть незаполненные разделы'),
    messageToUser: z.string().optional(),
  }),
});

export type DocumentReady = z.infer<typeof DocumentReadySchema>;