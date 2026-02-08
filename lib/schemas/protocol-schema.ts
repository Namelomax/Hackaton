import { z } from 'zod';

/**
 * Zod схема для протокола обследования
 * Структура строго соответствует формату документа
 */

// Участник (для таблиц)
export const ParticipantSchema = z.object({
  fullName: z.string().describe('ФИО'),
  position: z.string().describe('Должность'),
});

// Вопрос с ответом
export const QuestionAnswerSchema = z.object({
  question: z.string().describe('Текст вопроса'),
  answer: z.string().describe('Текст ответа'),
});

// Решение с ответственным
export const DecisionSchema = z.object({
  decision: z.string().describe('Текст решения'),
  responsible: z.string().describe('Ответственный (Исполнитель/Заказчик)'),
});

// Таблица особенностей миграции
export const MigrationFeatureSchema = z.object({
  tab: z.string().describe('Название вкладки'),
  features: z.string().describe('Описание особенностей'),
});

// Основная схема протокола обследования
export const ProtocolSchema = z.object({
  // 1. Номер и дата
  protocolNumber: z.string().describe('Номер протокола (например: №7)'),
  meetingDate: z.string().describe('Дата встречи в формате ДД.ММ.ГГГГ'),

  // 2. Повестка
  agenda: z.object({
    title: z.string().describe('Основная тема встречи'),
    items: z.array(z.string()).describe('Пункты повестки'),
  }),

  // 3. Участники
  participants: z.object({
    customer: z.object({
      organizationName: z.string().describe('Название организации заказчика'),
      people: z.array(ParticipantSchema),
    }),
    executor: z.object({
      organizationName: z.string().describe('Название организации исполнителя'),
      people: z.array(ParticipantSchema),
    }),
  }),

  // 4. Термины и определения
  termsAndDefinitions: z.array(
    z.object({
      term: z.string().describe('Термин'),
      definition: z.string().describe('Определение'),
    })
  ),

  // 5. Сокращения и обозначения
  abbreviations: z.array(
    z.object({
      abbreviation: z.string().describe('Сокращение'),
      fullForm: z.string().describe('Полная форма'),
    })
  ),

  // 6. Содержание встречи
  meetingContent: z.object({
    introduction: z.string().optional().describe('Вводная часть'),
    topics: z.array(
      z.object({
        title: z.string().describe('Название темы'),
        content: z.string().describe('Содержание обсуждения'),
        subtopics: z.array(
          z.object({
            title: z.string().optional(),
            content: z.string(),
          })
        ).optional(),
      })
    ),
    migrationFeatures: z.array(MigrationFeatureSchema).optional().describe('Особенности миграции (если применимо)'),
  }),

  // 7. Вопросы и ответы
  questionsAndAnswers: z.array(QuestionAnswerSchema),

  // 8. Решения
  decisions: z.array(DecisionSchema),

  // 9. Открытые вопросы
  openQuestions: z.array(z.string()),

  // 10. Согласовано
  approval: z.object({
    executorSignature: z.object({
      organization: z.string(),
      representative: z.string().describe('ФИО представителя'),
    }),
    customerSignature: z.object({
      organization: z.string(),
      representative: z.string().describe('ФИО представителя'),
    }),
  }),
});

export type Protocol = z.infer<typeof ProtocolSchema>;

/**
 * Схема для валидации и анализа исходной расшифровки встречи
 */
export const TranscriptAnalysisSchema = z.object({
  hasContradictions: z.boolean().describe('Обнаружены ли противоречия'),
  contradictions: z.array(z.string()).describe('Список обнаруженных противоречий'),
  hasAmbiguities: z.boolean().describe('Есть ли недосказанности/неясности'),
  ambiguities: z.array(z.string()).describe('Список недосказанностей'),
  missingCriticalInfo: z.array(z.string()).describe('Список критически важной недостающей информации'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Уровень уверенности в полноте данных'),
});

export type TranscriptAnalysis = z.infer<typeof TranscriptAnalysisSchema>;
