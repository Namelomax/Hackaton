import { z } from 'zod';

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

const toStr = (value: unknown) => (value == null ? '' : String(value));
const toArr = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** Приводит произвольный черновик (в т.ч. частичный от streamObject) к форме Protocol перед Zod-проверкой. */
export function coerceProtocolPartial(partial: unknown): Protocol {
  const p =
    partial && typeof partial === 'object' && !Array.isArray(partial)
      ? (partial as Record<string, unknown>)
      : {};

  const toPeople = (value: unknown) =>
    toArr(value).map((row: unknown) => {
      const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return {
        fullName: toStr(r.fullName ?? r.name),
        position: toStr(r.position ?? r.role),
      };
    });

  const meetingContentRaw =
    p.meetingContent && typeof p.meetingContent === 'object' && !Array.isArray(p.meetingContent)
      ? (p.meetingContent as Record<string, unknown>)
      : {};

  return {
    protocolNumber: toStr(p.protocolNumber),
    meetingDate: toStr(p.meetingDate),
    agenda: {
      title: toStr((p.agenda as Record<string, unknown> | undefined)?.title),
      items: toArr<string>((p.agenda as Record<string, unknown> | undefined)?.items).map(toStr),
    },
    participants: {
      customer: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.customer as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
      executor: {
        organizationName: toStr(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.organizationName,
        ),
        people: toPeople(
          ((p.participants as Record<string, unknown> | undefined)?.executor as Record<string, unknown> | undefined)
            ?.people,
        ),
      },
    },
    termsAndDefinitions: toArr(p.termsAndDefinitions).map((item: unknown) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return { term: toStr(row.term), definition: toStr(row.definition) };
    }),
    abbreviations: toArr(p.abbreviations).map((item: unknown) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return { abbreviation: toStr(row.abbreviation), fullForm: toStr(row.fullForm) };
    }),
    meetingContent: {
      introduction: meetingContentRaw.introduction !== undefined ? toStr(meetingContentRaw.introduction) : '',
      topics: toArr(meetingContentRaw.topics).map((topic: unknown) => {
        const t = topic && typeof topic === 'object' ? (topic as Record<string, unknown>) : {};
        return {
          title: toStr(t.title),
          content: toStr(t.content),
          subtopics: toArr(t.subtopics).map((sub: unknown) => {
            const s = sub && typeof sub === 'object' ? (sub as Record<string, unknown>) : {};
            return { title: s.title !== undefined ? toStr(s.title) : '', content: toStr(s.content) };
          }),
        };
      }),
      migrationFeatures: toArr(meetingContentRaw.migrationFeatures).map((feat: unknown) => {
        const f = feat && typeof feat === 'object' ? (feat as Record<string, unknown>) : {};
        return { tab: toStr(f.tab), features: toStr(f.features) };
      }),
    },
    questionsAndAnswers: toArr(p.questionsAndAnswers).map((qa: unknown) => {
      const row = qa && typeof qa === 'object' ? (qa as Record<string, unknown>) : {};
      return { question: toStr(row.question), answer: toStr(row.answer) };
    }),
    decisions: toArr(p.decisions).map((decision: unknown) => {
      const row = decision && typeof decision === 'object' ? (decision as Record<string, unknown>) : {};
      return { decision: toStr(row.decision), responsible: toStr(row.responsible) };
    }),
    openQuestions: toArr<string>(p.openQuestions).map(toStr),
    approval: {
      executorSignature: {
        organization: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.executorSignature as
              | Record<string, unknown>
              | undefined
          )?.organization,
        ),
        representative: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.executorSignature as
              | Record<string, unknown>
              | undefined
          )?.representative,
        ),
      },
      customerSignature: {
        organization: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.customerSignature as
              | Record<string, unknown>
              | undefined
          )?.organization,
        ),
        representative: toStr(
          (
            (p.approval as Record<string, unknown> | undefined)?.customerSignature as
              | Record<string, unknown>
              | undefined
          )?.representative,
        ),
      },
    },
  };
}

/**
 * Жёсткая проверка соответствия `ProtocolSchema` после получения итогового JSON от модели.
 * Частичный поток streamObject не гарантирует валидность — всегда вызывать на финальном объекте.
 */
export function parseProtocolStrict(input: unknown): Protocol {
  return ProtocolSchema.parse(coerceProtocolPartial(input));
}

/**
 * Тот же разбор без исключения — для логов и диагностики.
 */
export function safeParseProtocol(input: unknown) {
  return ProtocolSchema.safeParse(coerceProtocolPartial(input));
}

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

// Схема инструкции по формированию протокола
export const ProtocolInstructionSchema = z.object({
  instruction: z.string().describe('Подробная инструкция по созданию протокола'),
  openQuestions: z.array(z.string()).describe('Список вопросов для уточнения'),
});

export type ProtocolInstruction = z.infer<typeof ProtocolInstructionSchema>;
