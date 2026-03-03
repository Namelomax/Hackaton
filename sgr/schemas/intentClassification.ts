import { z } from 'zod';

/**
 * Схема SGR для классификации намерений
 * Решает проблему 10 (нестабильные результаты)
 */
export const IntentClassificationSchema = z.object({
  inputAnalysis: z.object({
    lastMessage: z.string(),
    conversationContext: z.array(z.string()),
    stage: z.enum(['initial', 'gathering', 'confirming', 'finalizing']).optional(),
  }),

  reasoning_steps: z.array(z.string()).describe(`
    Шаг 1: Проанализировать последнее сообщение
    Шаг 2: Оценить контекст диалога
    Шаг 3: Найти признаки запроса документа
    Шаг 4: Найти признаки продолжения чата
    Шаг 5: Определить уверенность
  `),

  evidence: z.object({
    forDocument: z.array(z.string()),
    forChat: z.array(z.string()),
  }),

  output: z.object({
    intent: z.enum(['chat', 'document']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    nextStep: z.string(),
  }),
});

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;