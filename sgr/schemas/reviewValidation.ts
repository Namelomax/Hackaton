import { z } from 'zod';

/**
 * Схема SGR для валидации исправлений
 * Решает проблемы 11 (исправления ухудшают) и 12 (игнорирование промтов)
 */
export const ReviewValidationSchema = z.object({
  inputAnalysis: z.object({
    documentContent: z.string(),
    reviewIssues: z.array(z.any()),
    previousVersions: z.array(z.string()),
    requestedFixes: z.array(z.string()),
  }),

  reasoning_steps: z.array(z.string()).describe(`
    Шаг 1: Проанализировать запрошенные исправления
    Шаг 2: Сравнить с предыдущими версиями
    Шаг 3: Оценить влияние каждого исправления
    Шаг 4: Определить, какие исправления применить
  `),

  analysis: z.object({
    fixesThatImprove: z.array(z.string()),
    fixesThatWorsen: z.array(z.string()),
    ambiguousFixes: z.array(z.string()),
    qualityTrend: z.enum(['improving', 'worsening', 'stable']),
  }),

  output: z.object({
    fixesToApply: z.array(z.string()),
    fixesToSkip: z.array(z.string()),
    skipReasons: z.array(z.string()),
    needsClarification: z.boolean(),
    clarificationQuestion: z.string().optional(),
    updatedDocument: z.string().optional(),
  }),
});

export type ReviewValidation = z.infer<typeof ReviewValidationSchema>;