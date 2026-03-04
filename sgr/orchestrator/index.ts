import { generateObject } from 'ai';
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import fs from 'fs/promises';
import path from 'path';

import {
  QualityCheckSchema,
  DocumentReadySchema,
  IntentClassificationSchema,
  ReviewValidationSchema,
  type QualityCheck,
  type DocumentReady,
  type IntentClassification,
  type ReviewValidation
} from '@/sgr/schemas';

export const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  baseURL: "https://openrouter.ai/api/v1",
  compatibility: "strict",
  headers: {
    "X-Title": "AISDK",
  },
});

export class SGROrchestrator {
  private model;
  private logDir: string;

  constructor() {
    this.model = openrouter.chat('openai/gpt-4o-mini');
    // Используем tmp директорию для production-среды (Vercel, etc.)
    const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    this.logDir = isProduction
      ? path.join(process.env.RUNTIME_TMP_DIR || '/tmp', 'sgr')
      : path.join(process.cwd(), 'sgr/logs');
    this.ensureLogDir();
  }

  private async ensureLogDir() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      // Игнорируем ошибки в production-среде - логи не критичны
      const isProduction = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
      if (!isProduction) {
        console.error('Failed to create log dir:', error);
      }
    }
  }

  private async logSGR<T>(type: string, input: any, output: T) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      input,
      output,
    };

    const logFile = path.join(this.logDir, `${type}_${Date.now()}.json`);
    await fs.writeFile(logFile, JSON.stringify(logEntry, null, 2));
    console.log(`📝 SGR Log saved: ${logFile}`);
  }

  /**
   * Проверка качества ответа перед отправкой
   */
  async checkQuality(
    proposedResponse: string,
    lastUserMessage: string,
    previousMessages: any[]
  ): Promise<QualityCheck['output']> {
    const previousAssistantMessages = previousMessages
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .slice(-5);

    const result = await generateObject({
      model: this.model,
      schema: QualityCheckSchema,
      prompt: `Проанализируй качество ответа ассистента.

Последнее сообщение пользователя:
${lastUserMessage}

Предложенный ответ ассистента:
${proposedResponse}

Предыдущие ответы ассистента (для проверки повторов):
${previousAssistantMessages.map((msg, i) => `${i+1}. ${msg.substring(0, 100)}...`).join('\n')}

Выполни структурированный анализ по схеме.
`,
      temperature: 0.1,
    });

    await this.logSGR('qualityCheck', {
      proposedResponse,
      lastUserMessage,
    }, result.object);

    return result.object.output;
  }

  /**
   * Проверка готовности к генерации документа
   */
  async checkDocumentReady(
    conversationHistory: any[],
    confirmedSections: string[] = []
  ): Promise<DocumentReady['output']> {
    const historyText = conversationHistory
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const result = await generateObject({
      model: this.model,
      schema: DocumentReadySchema,
      prompt: `Проанализируй готовность к формированию документа.

История диалога:
${historyText}

Подтвержденные разделы: ${confirmedSections.join(', ')}

Определи, можно ли уже формировать документ.
`,
      temperature: 0.1,
    });

    await this.logSGR('documentReady', {
      historyLength: conversationHistory.length,
      confirmedSections,
    }, result.object);

    return result.object.output;
  }

  /**
   * Классификация намерения пользователя
   */
  async classifyIntent(
    lastMessage: string,
    conversationContext: any[]
  ): Promise<IntentClassification['output']> {
    const contextText = conversationContext
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const result = await generateObject({
      model: this.model,
      schema: IntentClassificationSchema,
      prompt: `Определи намерение пользователя.

Контекст диалога:
${contextText}

Последнее сообщение:
${lastMessage}

Что хочет пользователь: продолжить чат или получить документ?
`,
      temperature: 0.1,
    });

    await this.logSGR('intentClassification', {
      lastMessage,
      contextLength: conversationContext.length,
    }, result.object);

    return result.object.output;
  }

  /**
   * Валидация исправлений от агента проверки
   */
  async validateReviewFixes(
    documentContent: string,
    reviewIssues: any[],
    previousVersions: string[] = []
  ): Promise<ReviewValidation['output']> {
    const result = await generateObject({
      model: this.model,
      schema: ReviewValidationSchema,
      prompt: `Проверь исправления для документа.

Текущая версия документа:
${documentContent}

Найденные проблемы:
${JSON.stringify(reviewIssues, null, 2)}

Предыдущие версии:
${previousVersions.map((v, i) => `Версия ${i+1}: ${v.substring(0, 200)}...`).join('\n')}

Какие исправления действительно улучшат документ?
`,
      temperature: 0.1,
    });

    await this.logSGR('reviewValidation', {
      documentLength: documentContent.length,
      issuesCount: reviewIssues.length,
    }, result.object);

    return result.object.output;
  }
}