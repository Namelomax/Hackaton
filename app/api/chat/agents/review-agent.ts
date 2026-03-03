'use server';

import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { SGROrchestrator } from '@/sgr/orchestrator';

const sgr = new SGROrchestrator();
let previousVersions: string[] = []; // Храним историю версий

/**
 * Review agent — проверяет готовый документ (протокол) на ошибки
 * с применением SGR для валидации исправлений
 */

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


export async function runDocumentReview(
  documentMarkdown: string
): Promise<DocumentReview & { needsClarification?: boolean; clarificationQuestion?: string }> {
  console.log('🔍 Review Agent: проверка документа с SGR');
  
  // Сохраняем версию для истории
  previousVersions.push(documentMarkdown);
  if (previousVersions.length > 5) previousVersions.shift(); // Храним последние 5
  
  const reviewPrompt = `Вы — эксперт по проверке деловых документов. Проанализируйте следующий протокол обследования и выявите все ошибки и проблемы.

ДОКУМЕНТ ДЛЯ ПРОВЕРКИ:
\`\`\`
${documentMarkdown}
\`\`\`

КРИТЕРИИ ПРОВЕРКИ:
1. Структура: должны быть все 10 разделов
2. Полнота: нет ли пустых разделов
3. Пунктуация: проверить знаки препинания
4. Орфография: ошибки в словах
5. Символы и кодировка: недопустимые символы
6. Логичность: согласованность между разделами
7. Терминология: консистентность понятий
8. Таблицы: правильный формат

ОТВЕТИТЬ В ФОРМАТЕ JSON:
{
  "isValid": boolean,
  "overallQuality": number,
  "issues": [
    {
      "level": "error" | "warning" | "info",
      "section": "название раздела",
      "issue": "описание проблемы",
      "suggestion": "предложение по исправлению"
    }
  ],
  "summary": "краткий общий вывод"
}`;

  try {
    const openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: 'https://openrouter.ai/api/v1',
      compatibility: 'strict',
    });
    
    const model = openrouter.chat('arcee-ai/trinity-large-preview:free');
    
    // Получаем обычный результат проверки
    const response = await generateText({
      model,
      prompt: reviewPrompt,
      temperature: 0.1,
    });

    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Не удалось распарсить ответ агента проверки');
    }

    const reviewResult: DocumentReview = JSON.parse(jsonMatch[0]);
    
    // Валидируем исправления через SGR (проблемы 11, 12)
    const validation = await sgr.validateReviewFixes(
      documentMarkdown,
      reviewResult.issues,
      previousVersions.slice(0, -1) // Все версии кроме текущей
    );
    
    console.log('✅ Review validation:', {
      fixesToApply: validation.fixesToApply.length,
      fixesToSkip: validation.fixesToSkip.length,
      needsClarification: validation.needsClarification
    });
    
    // Если нужны уточнения
    if (validation.needsClarification) {
      return {
        ...reviewResult,
        needsClarification: true,
        clarificationQuestion: validation.clarificationQuestion,
      };
    }
    
    // Логируем пропущенные исправления
    if (validation.fixesToSkip.length > 0) {
      console.log('⏭️ Пропущены исправления:', validation.skipReasons);
    }
    
    // Возвращаем результат с валидированными исправлениями
    return {
      ...reviewResult,
      issues: reviewResult.issues.filter(issue => 
        validation.fixesToApply.includes(issue.issue)
      ),
    };
    
  } catch (error) {
    console.error('[review-agent] Error:', error);
    throw new Error(`Ошибка при проверке документа: ${String(error)}`);
  }
}