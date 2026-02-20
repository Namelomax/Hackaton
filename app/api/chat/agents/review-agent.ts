'use server';

import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export interface ReviewIssue {
  level: 'error' | 'warning' | 'info';
  section: string;
  issue: string;
  suggestion?: string;
}

export interface DocumentReview {
  isValid: boolean;
  issues: ReviewIssue[];
  summary: string;
  overallQuality: number; // 0-100
}

/**
 * Review agent — проверяет готовый документ (протокол) на ошибки:
 * - Структура и полнота
 * - Логичность и связность
 * - Пунктуация и орфография
 * - Посторонние символы (китайские, невидимые и т.д.)
 * - Консистентность терминологии
 */
export async function runDocumentReview(documentMarkdown: string): Promise<DocumentReview> {
  const reviewPrompt = `Вы — эксперт по проверке деловых документов. Проанализируйте следующий протокол обследования и выявите все ошибки и проблемы.

ДОКУМЕНТ ДЛЯ ПРОВЕРКИ:
\`\`\`
${documentMarkdown}
\`\`\`

КРИТЕРИИ ПРОВЕРКИ:
1. Структура: должны быть все 10 разделов (Дата, Повестка, Участники, Термины, Сокращения, Содержание, Вопросы, Решения, Открытые вопросы, Согласовано)
2. Полнота: нет ли пустых разделов или неполных данных, которые обозначены как "незаполнено" или "N/A"
3. Пунктуация: проверить знаки препинания, особенно в списках и таблицах
4. Орфография: ошибки в словах, неправильные буквы (особенно внимание на китайские символы, странные кодировки вроде "䐡00")
5. Символы и кодировка: искать недопустимые символы, невидимые символы, битые кодировки
6. Логичность: проверить логический поток, согласованность между разделами
7. Терминология: использованы ли одинаково одни и те же понятия по всему документу
8. Таблицы: правильный формат, выравнивание колонок, полные данные

ОТВЕТИТЬ В ФОРМАТЕ JSON (без markdown блока):
{
  "isValid": boolean,  // true если ошибок нет или только info-уровень
  "overallQuality": number,  // 0-100, где 100 это идеальный документ
  "issues": [
    {
      "level": "error" | "warning" | "info",
      "section": "название раздела",
      "issue": "описание проблемы",
      "suggestion": "предложение по исправлению (опционально)"
    }
  ],
  "summary": "краткий общий вывод (2-3 предложения)"
}

Будьте строги — это деловой документ, каждая ошибка важна.`;

  try {
    const openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: 'https://openrouter.ai/api/v1',
      compatibility: 'strict',
    });
    
    const model = openrouter.chat('arcee-ai/trinity-large-preview:free');
    
    const response = await generateText({
      model,
      prompt: reviewPrompt,
      temperature: 0.3, // Низкая температура для более надежного результата
      maxCompletionTokens: 2000,
    });

    // Парсим JSON ответ
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Не удалось распарсить ответ агента проверки');
    }

    const parsed: DocumentReview = JSON.parse(jsonMatch[0]);
    return parsed;
  } catch (error) {
    console.error('[review-agent] Error:', error);
    throw new Error(`Ошибка при проверке документа: ${String(error)}`);
  }
}
