import { z } from 'zod';

/**
 * Схема SGR для проверки качества ответа перед отправкой
 * Решает проблемы: 6 (речевые ошибки), 7 (форматирование), 8 (дублирование)
 */
export const QualityCheckSchema = z.object({
  // Шаг 1: Анализ входных данных
  inputAnalysis: z.object({
    proposedResponse: z.string(),
    lastUserMessage: z.string(),
    previousAssistantMessages: z.array(z.string()),
  }),

  // Шаг 2: Шаги рассуждения
  reasoning_steps: z.array(z.string()).describe(`
    Шаг 1: Найти речевые ошибки в proposedResponse
    Шаг 2: Проверить сохранение форматирования из lastUserMessage (переносы строк, пробелы)
    Шаг 3: Сравнить с previousAssistantMessages на наличие повторов
    Шаг 4: Оценить общее качество
  `),

  // Шаг 3: Результаты проверок
  checks: z.object({
    speechErrors: z.array(z.object({
      error: z.string(),
      correction: z.string(),
    })),
    formattingPreserved: z.boolean(),
    formattingIssues: z.array(z.string()),
    duplicatesFound: z.array(z.string()),
  }),

  // Шаг 4: Итоговый вывод
  output: z.object({
    correctedResponse: z.string(),
    qualityScore: z.number().min(1).max(10),
    readyToSend: z.boolean(),
    nextAction: z.enum(['send', 'ask_clarification', 'regenerate']),
  }),
});

export type QualityCheck = z.infer<typeof QualityCheckSchema>;