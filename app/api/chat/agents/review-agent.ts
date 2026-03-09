'use server';

import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
<<<<<<< HEAD
import { SGROrchestrator } from '@/sgr/orchestrator';

const sgr = new SGROrchestrator();
let previousVersions: string[] = []; // Храним историю версий

/**
 * Review agent — проверяет готовый документ (протокол) на ошибки
 * с применением SGR для валидации исправлений
 */
=======
>>>>>>> main

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
<<<<<<< HEAD
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
=======
}

/**
 * SGR-схема для детерминированной проверки документов (Schema-Guided Reasoning)
 * Применяет паттерны: Cascade (пошаговое рассуждение), Cycle (повторяющиеся проверки),
 * Routing (классификация ошибок по типам)
 */
interface SgrDocumentReviewSchema {
  /** Этап 1: Подготовка и нормализация */
  stage_1_input_analysis: {
    /** Исходная длина документа */
    original_length: number;
    /** Нормализованный документ (приведение к единому формату) */
    normalized_content: string;
    /** Выявленные проблемы нормализации (дублирование строк, невидимые символы) */
    normalization_issues: string[];
  };

  /** Этап 2: Cascade - Проверка структуры (10 обязательных разделов) */
  stage_2_structure_cascade: {
    /** Список найденных разделов с заголовками */
    found_sections: Array<{
      section_number: number;
      section_name: string;
      has_content: boolean;
      content_preview: string;
    }>;
    /** Список отсутствующих разделов */
    missing_sections: number[];
    /** Пустые разделы */
    empty_sections: number[];
  };

  /** Этап 3: Cycle - Детальная проверка каждого раздела */
  stage_3_section_cycle: {
    /** Результаты проверки по каждому разделу */
    section_checks: Array<{
      section: string;
      checks_performed: string[];
      issues_found: Array<{
        type: 'error' | 'warning';
        description: string;
        evidence: string;
      }>;
    }>;
  };

  /** Этап 4: Routing - Классификация и верификация ошибок */
  stage_4_error_routing: {
    /** Критические ошибки (блокирующие) */
    errors: Array<{
      category: 'structure' | 'format' | 'encoding' | 'content' | 'style';
      section: string;
      issue: string;
      suggestion: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
    /** Предупреждения (неблокирующие) */
    warnings: Array<{
      category: 'format' | 'style' | 'terminology' | 'punctuation';
      section: string;
      issue: string;
      suggestion: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
    /** Информационные замечания */
    info: Array<{
      category: 'quality' | 'completeness';
      description: string;
    }>;
  };

  /** Этап 5: Дедупликация и консолидация */
  stage_5_deduplication: {
    /** Выявленные дубликаты ошибок */
    duplicates_found: string[];
    /** Объединенные ошибки */
    merged_issues: string[];
    /** Финальный список после дедупликации */
    final_issues_count: {
      errors: number;
      warnings: number;
      info: number;
    };
  };

  /** Этап 6: Финальная верификация */
  stage_6_verification: {
    /** Перекрестная проверка: все ли ошибки обоснованы */
    verification_checks: string[];
    /** Подтвержденные ошибки */
    confirmed_issues: number;
    /** Отклоненные ошибки (ложные срабатывания) */
    rejected_issues: number;
    /** Итоговый вердикт */
    final_verdict: {
      isValid: boolean;
      summary: string;
    };
  };

  /** Этап 7: Формирование ответа */
  stage_7_output: {
    isValid: boolean;
    issues: Array<{
      level: 'error' | 'warning' | 'info';
      section: string;
      issue: string;
      suggestion: string;
    }>;
    summary: string;
  };
}

/**
 * Review agent — проверяет готовый документ (протокол) на ошибки с использованием SGR.
 * 
 * SGR-паттерны:
 * - **Cascade**: Пошаговое прохождение 7 обязательных этапов проверки
 * - **Cycle**: Итеративная проверка каждого раздела по единому чек-листу
 * - **Routing**: Классификация ошибок по категориям с верификацией
 * - **Deduplication**: Явный этап устранения дубликатов
 * 
 * Преимущества SGR:
 * - Детерминированность: одинаковый документ → одинаковые результаты
 * - Аудируемость: каждый шаг проверки явно задокументирован
 * - Тестируемость: промежуточные результаты можно валидировать
 */
export async function runDocumentReview(documentMarkdown: string): Promise<DocumentReview> {
  // Нормализация документа перед проверкой
  const normalizedDoc = documentMarkdown
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ') // Замена неразрывных пробелов на обычные
    .trim();

  const sgrReviewPrompt = `# РОЛЬ: Вы — AI-эксперт по проверке деловых документов (протоколов обследования)
# МЕТОД: Schema-Guided Reasoning (SGR) — структурированное рассуждение по схеме

================================================================================
## ДОКУМЕНТ ДЛЯ ПРОВЕРКИ:
================================================================================
\`\`\`
${normalizedDoc}
\`\`\`

================================================================================
## SGR-СХЕМА ПРОВЕРКИ (7 ОБЯЗАТЕЛЬНЫХ ЭТАПОВ)
================================================================================

ВЫ ПОШАГОВО ПРОХОДИТЕ ВСЕ 7 ЭТАПОВ. КАЖДЫЙ ЭТАП — ОБЯЗАТЕЛЬНЫЙ CHECKPOINT.
НЕ ПЕРЕХОДИТЕ К СЛЕДУЮЩЕМУ ЭТАПУ, ПОКА НЕ ЗАВЕРШИТЕ ПРЕДЫДУЩИЙ.

================================================================================
### ЭТАП 1: ПОДГОТОВКА И НОРМАЛИЗАЦИЯ
================================================================================

**ЗАДАЧА:** Подготовить документ к проверке, выявить проблемы форматирования

**ДЕЙСТВИЯ:**
1. Зафиксировать исходную длину документа
2. Нормализовать документ (приведение к единому формату)
3. Выявить проблемы нормализации:
   - Дублирование строк/абзацев
   - Невидимые символы (кроме обычных пробелов)
   - Проблемы с переносами строк (Shift+Enter vs Enter)
   - Лишние пробелы, табуляции

**ФОРМАТ ВЫВОДА ЭТАПА 1:**
\`\`\`json
{
  "stage_1_input_analysis": {
    "original_length": <число>,
    "normalized_content": "<текст>",
    "normalization_issues": ["<проблема 1>", "<проблема 2>"]
  }
}
\`\`\`

================================================================================
### ЭТАП 2: CASCADE — ПРОВЕРКА СТРУКТУРЫ (10 РАЗДЕЛОВ)
================================================================================

**ЗАДАЧА:** Найти все 10 обязательных разделов, зафиксировать отсутствующие

**ОБЯЗАТЕЛЬНЫЕ РАЗДЕЛЫ:**
1. Дата встречи (формат: ДД.ММ.ГГГГ)
2. Повестка (тема + пункты)
3. Участники (таблицы: Заказчик и Исполнитель)
4. Термины и определения
5. Сокращения и обозначения
6. Содержание встречи
7. Вопросы и ответы
8. Решения с ответственными
9. Открытые вопросы
10. Согласовано (подписи)

**ДЕЙСТВИЯ:**
1. Прочитать документ ПОЛНОСТЬЮ
2. Найти ВСЕ заголовки с цифрами (1., 2., 3. ... 10.)
3. Для КАЖДОГО найденного раздела зафиксировать:
   - Номер раздела
   - Название раздела
   - Наличие содержимого (true/false)
   - Краткое превью содержимого (1-2 слова)
4. Сравнить с эталонным списком из 10 разделов
5. Зафиксировать отсутствующие разделы (номера)
6. Зафиксировать пустые разделы (номера)

**КРИТИЧЕСКИ ВАЖНО:**
- Если раздел НАЙДЕН и содержит данные — НЕ создавать ошибку
- ERROR ТОЛЬКО если раздел ДЕЙСТВИТЕЛЬНО отсутствует (нет заголовка)
- ERROR если раздел пуст или содержит "N/A", "не предоставлено"

**ФОРМАТ ВЫВОДА ЭТАПА 2:**
\`\`\`json
{
  "stage_2_structure_cascade": {
    "found_sections": [
      {"section_number": 1, "section_name": "Дата встречи", "has_content": true, "content_preview": "07.04.2026"}
    ],
    "missing_sections": [5],
    "empty_sections": []
  }
}
\`\`\`

================================================================================
### ЭТАП 3: CYCLE — ДЕТАЛЬНАЯ ПРОВЕРКА КАЖДОГО РАЗДЕЛА
================================================================================

**ЗАДАЧА:** Проверить каждый найденный раздел по единому чек-листу

**ЧЕК-ЛИСТ ПРОВЕРКИ (применить к КАЖДОМУ разделу):**

**3.1. Проверка ФИО участников (для раздела 3):**
- ФИО должно содержать МИНИМУМ 2 слова (фамилия + имя)
- Если ТОЛЬКО имя (например, "Екатерина") → ERROR
- Если фамилия + имя, но без отчества → WARNING
- Если 3 слова (фамилия, имя, отчество) → корректно
- Должность должна быть указана → если нет: ERROR

**3.2. Проверка формата дат (для раздела 1):**
- Формат ДД.ММ.ГГГГ (например, 07.04.2026)
- Если формат нарушен → ERROR

**3.3. Проверка кодировки (для ВСЕХ разделов):**
- Искать CJK символы: \\u3000-\\u30FF, \\u3400-\\u4DBF, \\u4E00-\\u9FFF
- НЕ помечать обычные пробелы (\\u0020), неразрывные (\\u00A0)
- НЕ помечать кириллицу (\\u0400-\\u04FF), латиницу (\\u0000-\\u007F)
- Если найден CJK → ERROR с указанием символа и позиции

**3.4. Проверка стиля (для ВСЕХ разделов):**
- **Эмоциональные выражения**: восклицательные знаки, разговорные частицы
- **Сленг**: неформальные выражения, молодёжный сленг, мемы
- **Разговорный стиль**: фразы для личной переписки ("привет", "пока", "классно")
- **Слова-маркеры неделового стиля**: "Мяу", "круто", "супер", "прикольно"
- Если найдено → ERROR с указанием слова и контекста

**3.5. Проверка полноты данных:**
- Раздел содержит данные (не пустой)?
- Таблицы имеют строки с данными?
- Если пусто → ERROR

**3.6. Проверка терминологии:**
- Один термин используется одинаково во всём документе?
- Если разное написание → WARNING

**3.7. Проверка пунктуации:**
- Точки в конце предложений?
- Запятые в перечислениях?
- Если нарушения → WARNING

**3.8. Проверка нумерации:**
- Нумерация пунктов последовательная (1, 2, 3...)?
- Нет ли дублирования номеров?
- Если нарушения → WARNING

**ФОРМАТ ВЫВОДА ЭТАПА 3:**
\`\`\`json
{
  "stage_3_section_cycle": {
    "section_checks": [
      {
        "section": "Участники",
        "checks_performed": ["ФИО", "должность", "стиль", "кодировка"],
        "issues_found": [
          {"type": "error", "description": "ФИО без фамилии", "evidence": "Екатерина"}
        ]
      }
    ]
  }
}
\`\`\`

================================================================================
### ЭТАП 4: ROUTING — КЛАССИФИКАЦИЯ И ВЕРИФИКАЦИЯ ОШИБОК
================================================================================

**ЗАДАЧА:** Классифицировать все найденные ошибки, проверить обоснованность

**КАТЕГОРИИ ОШИБОК:**

**ERROR (критическая, требует исправления):**
- category: "structure" — отсутствует обязательный раздел
- category: "format" — неверный формат даты, таблицы
- category: "encoding" — CJK символы
- category: "content" — пустой раздел, нет ответственного, неполное ФИО
- category: "style" — неделовой стиль, сленг

**WARNING (предупреждение, желательно исправить):**
- category: "format" — опечатки, нарушение нумерации
- category: "style" — стилистические ошибки, канцеляризмы
- category: "terminology" — несогласованность терминов
- category: "punctuation" — пунктуационные ошибки

**INFO (информация, не требует исправления):**
- category: "quality" — документ соответствует требованиям
- category: "completeness" — разделы заполнены полностью

**ДЕЙСТВИЯ:**
1. Собрать ВСЕ ошибки из Этапа 3
2. Классифицировать каждую по категории
3. Оценить уверенность (confidence): high/medium/low
4. Для каждой ошибки сформулировать конкретное предложение по исправлению

**ФОРМАТ ВЫВОДА ЭТАПА 4:**
\`\`\`json
{
  "stage_4_error_routing": {
    "errors": [
      {
        "category": "content",
        "section": "Участники",
        "issue": "ФИО без фамилии",
        "suggestion": "Добавить фамилию",
        "confidence": "high"
      }
    ],
    "warnings": [...],
    "info": [...]
  }
}
\`\`\`

================================================================================
### ЭТАП 5: ДЕДУПЛИКАЦИЯ И КОНСОЛИДАЦИЯ
================================================================================

**ЗАДАЧА:** Устранить дублирование ошибок, консолидировать похожие

**ДЕЙСТВИЯ:**
1. Проверить ВСЕ ошибки на дублирование:
   - Одинаковая проблема в разных местах → перечислить все места в одном issue
   - Одинаковая формулировка → объединить
2. Зафиксировать найденные дубликаты
3. Зафиксировать объединенные ошибки
4. Подсчитать финальное количество

**ПРАВИЛА:**
- НЕ создавать несколько issues для одной типовой проблемы
- Если одна ошибка повторяется → перечислить все вхождения в одном issue
- Пример: "В разделе 3 у 2 участников неполное ФИО: Екатерина, Иван"

**ФОРМАТ ВЫВОДА ЭТАПА 5:**
\`\`\`json
{
  "stage_5_deduplication": {
    "duplicates_found": ["Ошибка 'нет должности' найдена у 3 участников"],
    "merged_issues": ["Объединены 3 ошибки ФИО в одну"],
    "final_issues_count": {"errors": 2, "warnings": 1, "info": 0}
  }
}
\`\`\`

================================================================================
### ЭТАП 6: ФИНАЛЬНАЯ ВЕРИФИКАЦИЯ
================================================================================

**ЗАДАЧА:** Перекрестная проверка, отсев ложных срабатываний

**ДЕЙСТВИЯ:**
1. Выполнить проверочные вопросы:
   - Все ли ошибки подтверждены доказательствами из документа?
   - Нет ли ложных срабатываний (например, обычный пробел помечен как CJK)?
   - Соответствует ли классификация типу ошибки?
   - Все ли предложения по исправлению практичны?
2. Подтвердить обоснованные ошибки
3. Отклонить ложные срабатывания
4. Сформулировать итоговый вердикт

**ПРАВИЛА ВЕРИФИКАЦИИ:**
- isValid = true ТОЛЬКО если confirmed errors = 0
- summary должен отражать реальное состояние
- Не создавать ложных ошибок — если сомневаешься, пропусти

**ФОРМАТ ВЫВОДА ЭТАПА 6:**
\`\`\`json
{
  "stage_6_verification": {
    "verification_checks": [
      "Все CJK символы подтверждены Unicode-кодами",
      "Все отсутствующие разделы перепроверены"
    ],
    "confirmed_issues": 3,
    "rejected_issues": 1,
    "final_verdict": {
      "isValid": false,
      "summary": "Найдено 3 критические ошибки, требуется исправление"
    }
  }
}
\`\`\`

================================================================================
### ЭТАП 7: ФОРМИРОВАНИЕ ОТВЕТА
================================================================================

**ЗАДАЧА:** Сформировать финальный JSON-ответ

**ТРЕБОВАНИЯ:**
1. Использовать ТОЛЬКО подтвержденные данные из Этапа 6
2. isValid = true ТОЛЬКО если нет ошибок уровня "error"
3. Каждый issue должен быть конкретным с указанием места и доказательства
4. suggestion должен быть практичным
5. summary должен отражать реальное состояние

**ФОРМАТ ФИНАЛЬНОГО ОТВЕТА:**
\`\`\`json
{
  "stage_7_output": {
    "isValid": true/false,
    "issues": [
      {
        "level": "error",
        "section": "Участники",
        "issue": "Участник 'Екатерина' указан только по имени без фамилии",
        "suggestion": "Указать полную фамилию, например: 'Екатерина Иванова'"
      }
    ],
    "summary": "Найдено 2 критические ошибки. Документ требует исправления."
  }
}
\`\`\`

================================================================================
## ТРЕБОВАНИЯ К ВЫВОДУ (КРИТИЧЕСКИ ВАЖНО)
================================================================================

1. **ВЫВОДИТЕ ПОЛНУЮ SGR-СХЕМУ** — все 7 этапов в формате JSON
2. **КАЖДЫЙ ЭТАП** должен быть завершен перед переходом к следующему
3. **НЕ ПРОПУСКАТЬ ЭТАПЫ** — даже если кажется, что они пустые
4. **ДЕТЕКЦИЯ ДУБЛИКАТОВ** — Этап 5 обязателен для устранения дублирования
5. **ВЕРИФИКАЦИЯ** — Этап 6 подтверждает или отклоняет ошибки
6. **ДЕТЕРМИНИРОВАННОСТЬ** — одинаковый документ → одинаковые результаты

================================================================================
## ПРИМЕР ПОЛНОГО SGR-ОТВЕТА
================================================================================

\`\`\`json
{
  "stage_1_input_analysis": {
    "original_length": 1523,
    "normalized_content": "...",
    "normalization_issues": ["Заменены 2 неразрывных пробела на обычные"]
  },
  "stage_2_structure_cascade": {
    "found_sections": [
      {"section_number": 1, "section_name": "Дата встречи", "has_content": true, "content_preview": "07.04.2026"},
      {"section_number": 2, "section_name": "Повестка", "has_content": true, "content_preview": "Обсуждение..."},
      {"section_number": 3, "section_name": "Участники", "has_content": true, "content_preview": "Заказчик:..."}
    ],
    "missing_sections": [5],
    "empty_sections": []
  },
  "stage_3_section_cycle": {
    "section_checks": [
      {
        "section": "Участники",
        "checks_performed": ["ФИО", "должность", "стиль"],
        "issues_found": [
          {"type": "error", "description": "ФИО без фамилии", "evidence": "Екатерина"}
        ]
      }
    ]
  },
  "stage_4_error_routing": {
    "errors": [
      {
        "category": "structure",
        "section": "Структура",
        "issue": "Отсутствует раздел 5 'Сокращения и обозначения'",
        "suggestion": "Добавить раздел 5 или указать 'Сокращения не используются'",
        "confidence": "high"
      },
      {
        "category": "content",
        "section": "Участники",
        "issue": "ФИО без фамилии",
        "suggestion": "Добавить фамилию",
        "confidence": "high"
      }
    ],
    "warnings": [],
    "info": []
  },
  "stage_5_deduplication": {
    "duplicates_found": [],
    "merged_issues": [],
    "final_issues_count": {"errors": 2, "warnings": 0, "info": 0}
  },
  "stage_6_verification": {
    "verification_checks": [
      "Раздел 5 действительно отсутствует",
      "ФИО 'Екатерина' подтверждено как неполное"
    ],
    "confirmed_issues": 2,
    "rejected_issues": 0,
    "final_verdict": {
      "isValid": false,
      "summary": "Найдено 2 критические ошибки. Документ требует исправления."
    }
  },
  "stage_7_output": {
    "isValid": false,
    "issues": [
      {
        "level": "error",
        "section": "Структура",
        "issue": "Отсутствует раздел 5 'Сокращения и обозначения'",
        "suggestion": "Добавить раздел 5 со списком сокращений"
      },
      {
        "level": "error",
        "section": "Участники",
        "issue": "Участник 'Екатерина' указан только по имени без фамилии",
        "suggestion": "Указать полную фамилию, например: 'Екатерина Иванова'"
      }
    ],
    "summary": "Найдено 2 критические ошибки. Документ требует исправления."
  }
}
\`\`\`

================================================================================
## НАЧИНАЙТЕ SGR-ПРОВЕРКУ. ВЫВОДИТЕ ПОЛНУЮ СХЕМУ ВСЕХ 7 ЭТАПОВ.
================================================================================`;
>>>>>>> main

  try {
    const openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: 'https://openrouter.ai/api/v1',
      compatibility: 'strict',
    });
<<<<<<< HEAD
    
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
=======

    const model = openrouter.chat('arcee-ai/trinity-large-preview:free');

    console.log('[review-agent] === НАЧАЛО SGR-ПРОВЕРКИ ДОКУМЕНТА ===');
    console.log('[review-agent] Длина документа:', normalizedDoc.length, 'символов');
    const startTime = Date.now();

    const response = await generateText({
      model,
      prompt: sgrReviewPrompt,
      temperature: 0.0, // Нулевая температура для максимальной детерминированности
      seed: 42, // Фиксированный seed для воспроизводимости
    });

    const elapsedTime = Date.now() - startTime;
    console.log(`[review-agent] Генерация завершена за ${elapsedTime}ms`);
    console.log('[review-agent] Длина сырого ответа:', response.text.length, 'символов');

    // Извлекаем JSON (всё между первой { и последней })
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[review-agent] ❌ JSON не найден в ответе');
      console.log('[review-agent] Полный ответ (первые 2000 символов):');
      console.log(response.text.slice(0, 2000));
      throw new Error('Не удалось распарсить ответ агента проверки');
    }

    // Извлекаем SGR-рассуждения (всё до JSON) для логирования
    const reasoningText = response.text.substring(0, jsonMatch.index).trim();
    console.log('[review-agent] === SGR-РАССУЖДЕНИЯ МОДЕЛИ ===');
    console.log(reasoningText);
    console.log('[review-agent] === КОНЕЦ SGR-РАССУЖДЕНИЙ ===');

    const fullParsed = JSON.parse(jsonMatch[0]);

    // Извлекаем финальный результат из stage_7_output
    let parsed: DocumentReview;
    if (fullParsed.stage_7_output) {
      parsed = {
        isValid: fullParsed.stage_7_output.isValid,
        issues: fullParsed.stage_7_output.issues,
        summary: fullParsed.stage_7_output.summary,
      };
    } else {
      // Fallback для обратной совместимости
      parsed = {
        isValid: fullParsed.isValid,
        issues: fullParsed.issues,
        summary: fullParsed.summary,
      };
    }

    // Валидация структуры ответа
    if (typeof parsed.isValid !== 'boolean') {
      console.warn('[review-agent] ⚠️ Неверное поле isValid, установлено false');
      parsed.isValid = false;
    }
    if (!Array.isArray(parsed.issues)) {
      console.warn('[review-agent] ⚠️ Неверное поле issues, установлен пустой массив');
      parsed.issues = [];
    }
    if (!parsed.summary || typeof parsed.summary !== 'string') {
      console.warn('[review-agent] ⚠️ Неверное поле summary, установлено значение по умолчанию');
      parsed.summary = 'Ошибка формирования ответа проверки.';
    }

    // Подсчёт статистики
    const errorCount = parsed.issues.filter(i => i.level === 'error').length;
    const warningCount = parsed.issues.filter(i => i.level === 'warning').length;
    const infoCount = parsed.issues.filter(i => i.level === 'info').length;

    console.log('[review-agent] === РЕЗУЛЬТАТЫ SGR-ПРОВЕРКИ ===');
    console.log(`[review-agent] isValid: ${parsed.isValid}`);
    console.log(`[review-agent] Найдено ошибок: ${errorCount} (error), ${warningCount} (warning), ${infoCount} (info)`);
    console.log(`[review-agent] Summary: ${parsed.summary}`);

    // Логирование SGR-этапов для отладки
    if (fullParsed.stage_1_input_analysis) {
      console.log('[review-agent] === ЭТАП 1: НОРМАЛИЗАЦИЯ ===');
      console.log(`[review-agent] Проблемы нормализации: ${fullParsed.stage_1_input_analysis.normalization_issues.length}`);
      fullParsed.stage_1_input_analysis.normalization_issues.forEach((issue: string) => {
        console.log(`[review-agent]   - ${issue}`);
      });
    }

    if (fullParsed.stage_2_structure_cascade) {
      console.log('[review-agent] === ЭТАП 2: СТРУКТУРА ===');
      console.log(`[review-agent] Найдено разделов: ${fullParsed.stage_2_structure_cascade.found_sections.length}`);
      console.log(`[review-agent] Отсутствует разделов: ${fullParsed.stage_2_structure_cascade.missing_sections.length}`);
      console.log(`[review-agent] Пустых разделов: ${fullParsed.stage_2_structure_cascade.empty_sections.length}`);
    }

    if (fullParsed.stage_5_deduplication) {
      console.log('[review-agent] === ЭТАП 5: ДЕДУПЛИКАЦИЯ ===');
      console.log(`[review-agent] Найдено дубликатов: ${fullParsed.stage_5_deduplication.duplicates_found.length}`);
      console.log(`[review-agent] Объединено ошибок: ${fullParsed.stage_5_deduplication.merged_issues.length}`);
    }

    if (fullParsed.stage_6_verification) {
      console.log('[review-agent] === ЭТАП 6: ВЕРИФИКАЦИЯ ===');
      console.log(`[review-agent] Подтверждено ошибок: ${fullParsed.stage_6_verification.confirmed_issues}`);
      console.log(`[review-agent] Отклонено ошибок: ${fullParsed.stage_6_verification.rejected_issues}`);
    }

    if (parsed.issues.length > 0) {
      console.log('[review-agent] === СПИСОК ОШИБОК ===');
      parsed.issues.forEach((issue, idx) => {
        console.log(`[review-agent] [${idx + 1}] ${issue.level.toUpperCase()} | ${issue.section}`);
        console.log(`[review-agent]     Проблема: ${issue.issue}`);
        if (issue.suggestion) {
          console.log(`[review-agent]     Решение: ${issue.suggestion}`);
        }
      });
      console.log('[review-agent] === КОНЕЦ СПИСКА ОШИБОК ===');
    } else {
      console.log('[review-agent] ✓ Ошибок не найдено');
    }
    console.log('[review-agent] === SGR-ПРОВЕРКА ЗАВЕРШЕНА ===');

    return parsed;
  } catch (error) {
    console.error('[review-agent] ❌ КРИТИЧЕСКАЯ ОШИБКА:', error);
    throw new Error(`Ошибка при проверке документа: ${String(error)}`);
  }
}
>>>>>>> main
