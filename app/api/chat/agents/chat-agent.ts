import { streamText, ModelMessage } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';

/**
 * SGR-схема для исправления замечаний (Schema-Guided Reasoning)
 * Применяет паттерны: Cascade (пошаговое исправление), Routing (классификация замечаний)
 */
interface SgrFixIssuesSchema {
  /** Этап 1: Анализ замечаний */
  stage_1_analysis: {
    /** Всего получено замечаний */
    total_issues: number;
    /** Классификация замечаний по типам */
    issues_by_category: {
      structure: number;
      formatting: number;
      content: number;
      style: number;
      other: number;
    };
    /** Критические замечания (требуют обязательного исправления) */
    critical_issues: string[];
  };

  /** Этап 2: Cascade - Пошаговое исправление каждого замечания */
  stage_2_fixes_cascade: Array<{
    /** Номер замечания */
    issue_number: number;
    /** Текст замечания */
    issue_text: string;
    /** Категория замечания */
    category: 'structure' | 'formatting' | 'content' | 'style' | 'other';
    /** Найдено ли место в документе */
    location_found: boolean;
    /** Описание внесённых изменений */
    fix_description: string;
    /** Статус исправления */
    status: 'fixed' | 'requires_clarification' | 'cannot_fix';
  }>;

  /** Этап 3: Верификация исправлений */
  stage_3_verification: {
    /** Проверка: все ли критические замечания исправлены */
    critical_issues_resolved: boolean;
    /** Проверка: сохранена ли структура документа (10 разделов) */
    structure_preserved: boolean;
    /** Проверка: сохранён ли деловой стиль */
    style_preserved: boolean;
    /** Необоснованные замечания (требуют уточнения) */
    unclear_issues: string[];
    /** Дополнительные исправления (по усмотрению редактора) */
    additional_fixes: string[];
  };

  /** Этап 4: Формирование ответа */
  stage_4_output: {
    /** Список исправленных замечаний */
    fixed_issues: string[];
    /** Замечания, требующие уточнения */
    needs_clarification: string[];
    /** Исправленный документ (полная версия) */
    corrected_document: string;
  };
}

/**
 * SGR-промпт для обработки замечаний по документу
 * Применяет Schema-Guided Reasoning для детерминированного исправления ошибок
 */
function buildSgrFixIssuesPrompt(existingDocument: string, issuesText: string): string {
  return `ТЫ — AI-редактор деловых документов. Твоя задача — исправить документ по замечаниям с использованием Schema-Guided Reasoning (SGR).

================================================================================
## ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА:
================================================================================
\`\`\`
${existingDocument}
\`\`\`

================================================================================
## ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:
================================================================================
${issuesText}

================================================================================
## SGR-СХЕМА ИСПРАВЛЕНИЯ (4 ОБЯЗАТЕЛЬНЫХ ЭТАПА)
================================================================================

ВЫ ПОШАГОВО ПРОХОДИТЕ ВСЕ 4 ЭТАПА. КАЖДЫЙ ЭТАП — ОБЯЗАТЕЛЬНЫЙ CHECKPOINT.
НЕ ПЕРЕХОДИТЕ К СЛЕДУЮЩЕМУ ЭТАПУ, ПОКА НЕ ЗАВЕРШИТЕ ПРЕДЫДУЩИЙ.

================================================================================
### ЭТАП 1: АНАЛИЗ ЗАМЕЧАНИЙ
================================================================================

**ЗАДАЧА:** Классифицировать все замечания по типам и приоритетам

**ДЕЙСТВИЯ:**
1. Подсчитать общее количество замечаний
2. Классифицировать каждое замечание по категории:
   - **structure**: отсутствует раздел, нарушена структура
   - **formatting**: неверный формат таблиц, дат, списков
   - **content**: отсутствует информация, нет ответственного, неполное ФИО
   - **style**: неделовой стиль, речевые ошибки
   - **other**: остальные замечания
3. Выделить критические замечания (те, что блокируют принятие документа)

**КАТЕГОРИИ КРИТИЧЕСКИХ ЗАМЕЧАНИЙ:**
- Отсутствует обязательный раздел (из 10)
- В разделе "Решения" нет ответственного
- В разделе "Участники" отсутствует ФИО или должность
- Найден символ CJK (китайский/японский)
- Недельной стиль (сленг, эмоциональные выражения)

**ФОРМАТ ВЫВОДА ЭТАПА 1:**
\`\`\`json
{
  "stage_1_analysis": {
    "total_issues": 5,
    "issues_by_category": {
      "structure": 1,
      "formatting": 2,
      "content": 1,
      "style": 1,
      "other": 0
    },
    "critical_issues": ["Отсутствует раздел 5", "Нет ответственного в решении 3"]
  }
}
\`\`\`

================================================================================
### ЭТАП 2: CASCADE — ПОШАГОВОЕ ИСПРАВЛЕНИЕ
================================================================================

**ЗАДАЧА:** Исправить каждое замечание последовательно

**ДЕЙСТВИЯ ДЛЯ КАЖДОГО ЗАМЕЧАНИЯ:**
1. Прочитать замечание внимательно
2. Найти место в документе, к которому оно относится
3. Определить тип исправления:
   - **fix**: замечание понятное, можно исправить
   - **requires_clarification**: замечание непонятное, нужно уточнение
   - **cannot_fix**: замечание противоречивое или невыполнимое
4. Внести исправление в документ
5. Зафиксировать описание изменений

**ПРАВИЛА ИСПРАВЛЕНИЯ:**
- НЕ удалять существующую информацию, только исправлять ошибки
- СОХРАНИТЬ структуру документа (все 10 разделов)
- СОХРАНИТЬ деловой стиль
- Если замечание касается формата — исправить форматирование
- Если замечание касается содержания — добавить/исправить информацию
- Если замечание непонятно — пометить как requires_clarification

**ФОРМАТ ВЫВОДА ЭТАПА 2:**
\`\`\`json
{
  "stage_2_fixes_cascade": [
    {
      "issue_number": 1,
      "issue_text": "Отсутствует раздел 5 'Сокращения'",
      "category": "structure",
      "location_found": true,
      "fix_description": "Добавлен раздел 5 со списком сокращений",
      "status": "fixed"
    }
  ]
}
\`\`\`

================================================================================
### ЭТАП 3: ВЕРИФИКАЦИЯ ИСПРАВЛЕНИЙ
================================================================================

**ЗАДАЧА:** Проверить качество всех внесённых исправлений

**ПРОВЕРОЧНЫЕ ВОПРОСЫ:**
1. Все ли критические замечания исправлены?
2. Сохранена ли структура документа (все 10 разделов на месте)?
3. Сохранён ли деловой стиль документа?
4. Нет ли новых ошибок, внесённых при исправлении?
5. Все ли замечания понятны, или есть требующие уточнения?

**ДЕЙСТВИЯ:**
1. Подтвердить каждое исправление
2. Выявить необоснованные замечания (если есть)
3. Отметить дополнительные улучшения (если сделаны)

**ФОРМАТ ВЫВОДА ЭТАПА 3:**
\`\`\`json
{
  "stage_3_verification": {
    "critical_issues_resolved": true,
    "structure_preserved": true,
    "style_preserved": true,
    "unclear_issues": ["Замечание 3 требует уточнения — неясно, какой раздел имеется в виду"],
    "additional_fixes": ["Исправлена опечатка в разделе 4"]
  }
}
\`\`\`

================================================================================
### ЭТАП 4: ФОРМИРОВАНИЕ ОТВЕТА
================================================================================

**ЗАДАЧА:** Сформировать финальный ответ с исправленным документом

**ТРЕБОВАНИЯ:**
1. Перечислить все исправленные замечания
2. Перечислить замечания, требующие уточнения
3. Показать ПОЛНУЮ исправленную версию документа

**ФОРМАТ ФИНАЛЬНОГО ОТВЕТА:**
\`\`\`json
{
  "stage_4_output": {
    "fixed_issues": [
      "Замечание 1: Добавлен раздел 5 'Сокращения'",
      "Замечание 2: Исправлен формат таблицы участников",
      "Замечание 3: Добавлен ответственный в решение 3"
    ],
    "needs_clarification": [
      "Замечание 5: Неясно, к какому разделу относится"
    ],
    "corrected_document": "ПОЛНЫЙ ИСПРАВЛЕННЫЙ ДОКУМЕНТ В ФОРМАТЕ MARKDOWN"
  }
}
\`\`\`

================================================================================
## ТРЕБОВАНИЯ К ВЫВОДУ (КРИТИЧЕСКИ ВАЖНО)
================================================================================

1. **ВЫВОДИТЕ ПОЛНУЮ SGR-СХЕМУ** — все 4 этапа в формате JSON
2. **КАЖДЫЙ ЭТАП** должен быть завершен перед переходом к следующему
3. **НЕ ПРОПУСКАТЬ ЗАМЕЧАНИЯ** — каждое замечание должно быть обработано
4. **СОХРАНИТЬ СТРУКТУРУ** — все 10 разделов протокола должны быть на месте
5. **СОХРАНИТЬ ДЕЛОВОЙ СТИЛЬ** — не добавлять разговорные выражения
6. **ДЕТЕРМИНИРОВАННОСТЬ** — одинаковые замечания → одинаковые исправления

================================================================================
## ПРИМЕР ПОЛНОГО SGR-ОТВЕТА
================================================================================

\`\`\`json
{
  "stage_1_analysis": {
    "total_issues": 3,
    "issues_by_category": {
      "structure": 1,
      "formatting": 1,
      "content": 1,
      "style": 0,
      "other": 0
    },
    "critical_issues": ["Отсутствует раздел 5"]
  },
  "stage_2_fixes_cascade": [
    {
      "issue_number": 1,
      "issue_text": "Отсутствует раздел 5 'Сокращения'",
      "category": "structure",
      "location_found": true,
      "fix_description": "Добавлен раздел 5 со списком сокращений из контекста",
      "status": "fixed"
    },
    {
      "issue_number": 2,
      "issue_text": "Неверный формат таблицы",
      "category": "formatting",
      "location_found": true,
      "fix_description": "Исправлен формат таблицы в разделе 3",
      "status": "fixed"
    },
    {
      "issue_number": 3,
      "issue_text": "Нет ответственного",
      "category": "content",
      "location_found": true,
      "fix_description": "Добавлен ответственный 'Исполнитель' в решение 3",
      "status": "fixed"
    }
  ],
  "stage_3_verification": {
    "critical_issues_resolved": true,
    "structure_preserved": true,
    "style_preserved": true,
    "unclear_issues": [],
    "additional_fixes": []
  },
  "stage_4_output": {
    "fixed_issues": [
      "Замечание 1: Добавлен раздел 5 'Сокращения'",
      "Замечание 2: Исправлен формат таблицы участников",
      "Замечание 3: Добавлен ответственный в решение 3"
    ],
    "needs_clarification": [],
    "corrected_document": "ПРОТОКОЛ ОБСЛЕДОВАНИЯ №1\\n\\n1. Дата встречи: 07.04.2026\\n..."
  }
}
\`\`\`

================================================================================
## НАЧИНАЙТЕ SGR-ИСПРАВЛЕНИЕ. ВЫВОДИТЕ ПОЛНУЮ СХЕМУ ВСЕХ 4 ЭТАПОВ.
================================================================================`;
}

/**
 * Устаревшая функция (оставлена для обратной совместимости)
 * @deprecated Используйте buildSgrFixIssuesPrompt
 */
function buildFixIssuesPrompt(existingDocument: string, issuesText: string): string {
  return buildSgrFixIssuesPrompt(existingDocument, issuesText);
}

function buildConversationContext(messages: any[], limit: number = 24): string {
  const list = Array.isArray(messages) ? messages.slice(-limit) : [];
  return list
    .map((msg) => {
      const role = msg?.role || 'user';
      if (typeof msg?.content === 'string') return `${role}: ${msg.content}`;
      if (Array.isArray(msg?.parts)) {
        const text = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text;
        return text ? `${role}: ${text}` : '';
      }
      if (typeof msg?.text === 'string') return `${role}: ${msg.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function hasAttachedFiles(messages: any[]): boolean {
  return messages.some((msg) => {
    if (typeof msg?.content === 'string') {
      return msg.content.includes('AI-HIDDEN') || msg.content.includes('Вложенный файл');
    }
    if (Array.isArray(msg?.parts)) {
      return msg.parts.some((p: any) => p?.type === 'file');
    }
    return false;
  });
}

function adaptSystemPrompt(systemPrompt: string, hasFiles: boolean, messageCount: number, hasDocumentContent: boolean): string {
  // Если файлы загружены или сообщений уже больше одного → расшифровка получена
  if ((hasFiles || messageCount > 1) && !systemPrompt.includes('АДАПТАЦИЯ: Расшифровка получена')) {
    const adaptation = `АДАПТАЦИЯ: Расшифровка получена
════════════════════════════════════════════
⚡ ПРОПУСТИ ЭТАП 1 (приветствие)!
⚡ Ты уже имеешь расшифровку встречи.
⚡ НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации).
⚡ Начни со сбора участников встречи и их ФИО.
⚡ НЕ показывай приветствие "Привет! Я AI-агент..."
════════════════════════════════════════════

`;
    return adaptation + systemPrompt;
  }
  return systemPrompt;
}

export async function runChatAgent(context: AgentContext, systemPrompt: string, userPrompt: string) {
  const { messages, model, userId, conversationId, documentContent } = context;
  const messagesWithUserPrompt: ModelMessage[] = [];

  // Добавляем системный промпт от пользователя
  if (userPrompt && userPrompt.trim()) {
    messagesWithUserPrompt.push({
      role: 'system',
      content: userPrompt,
    });
  }

  // Проверяем, есть ли в сообщениях запрос на исправление замечаний
  const lastUserMessage = messages[messages.length - 1];
  let lastUserText = '';

  if (lastUserMessage) {
    const msg = lastUserMessage as any;
    if (typeof msg.content === 'string') {
      lastUserText = msg.content;
    } else if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string');
      lastUserText = textPart?.text || '';
    }
  }

  const hasFixRequest = lastUserText.includes('исправь') &&
                        (lastUserText.includes('замечан') || lastUserText.includes('ошибк') || lastUserText.includes('предлож'));

  // Если это запрос на исправление замечаний И есть документ — используем SGR-промпт
  if (hasFixRequest && documentContent && documentContent.trim()) {
    // Извлекаем текст замечаний из сообщения пользователя
    const issuesMatch = lastUserText.match(/ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:([\s\S]*)/i);
    const issuesText = issuesMatch ? issuesMatch[1] : lastUserText;

    const sgrFixPrompt = buildSgrFixIssuesPrompt(documentContent, issuesText);
    messagesWithUserPrompt.push({
      role: 'system',
      content: sgrFixPrompt,
    });

    // Добавляем только последнее сообщение пользователя (остальные не нужны для исправления)
    messagesWithUserPrompt.push(lastUserMessage);

    console.log('[chat-agent] === SGR-ИСПРАВЛЕНИЕ ЗАМЕЧАНИЙ ===');
    console.log('[chat-agent] Документ:', documentContent.length, 'символов');
    console.log('[chat-agent] Замечания:', issuesText.length, 'символов');
  } else {
    // Добавляем контекст документа, если он есть (пользователь редактировал вручную)
    if (documentContent && documentContent.trim()) {
      messagesWithUserPrompt.push({
        role: 'system',
        content: `ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n\n${documentContent}\n\nИспользуй эту версию как основу для дальнейшей работы. Если пользователь вносит изменения в документ, сохраняй их и учитывай в следующих ответах.`,
      });
    }

    messagesWithUserPrompt.push(...(messages as ModelMessage[]));
  }

  // Адаптируем systemPrompt в зависимости от контекста
  const hasFiles = hasAttachedFiles(messages);
  const adaptedSystemPrompt = adaptSystemPrompt(systemPrompt, hasFiles, messages.length, !!documentContent);

  const stream = streamText({
    model,
    temperature: 0,
    messages: messagesWithUserPrompt,
    system: adaptedSystemPrompt, // System instructions + adaptive header
  });

  return stream.toUIMessageStreamResponse({
    onFinish: async ({ messages: finished }) => {
      if (userId) {
        try {
          if (conversationId) {
            await updateConversation(conversationId, finished);
          } else {
            await saveConversation(userId, finished);
          }
        } catch (e) {
          console.error('chat persistence failed', e);
        }
      }
    },
  });
}
