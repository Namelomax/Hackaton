import { generateText } from 'ai';
import type { AgentContext } from './types';

export type IntentType = 'chat' | 'document';

/**
 * SGR-схема для классификации намерений (Schema-Guided Reasoning)
 * Применяет паттерн Routing для выбора между chat и document
 */
interface SgrIntentClassificationSchema {
  /** Этап 1: Анализ контекста диалога */
  stage_1_context_analysis: {
    /** Количество сообщений в диалоге */
    message_count: number;
    /** Есть ли загруженные файлы */
    has_attachments: boolean;
    /** Есть ли существующий документ */
    has_existing_document: boolean;
    /** Стадия диалога */
    conversation_stage: 'greeting' | 'information_gathering' | 'clarification' | 'finalization';
  };

  /** Этап 2: Анализ последнего сообщения пользователя */
  stage_2_message_analysis: {
    /** Текст сообщения (очищенный) */
    cleaned_text: string;
    /** Ключевые слова-маркеры */
    keywords: string[];
    /** Наличие команд на генерацию документа */
    has_document_command: boolean;
    /** Наличие подтверждений готовности */
    has_readiness_confirmation: boolean;
    /** Наличие запросов на уточнение */
    has_clarification_request: boolean;
  };

  /** Этап 3: Routing - Выбор пути */
  stage_3_routing: {
    /** Аргументы для "document" */
    arguments_for_document: string[];
    /** Аргументы для "chat" */
    arguments_for_chat: string[];
    /** Выбранный путь */
    selected_route: 'chat' | 'document';
    /** Уверенность в выборе (0.0-1.0) */
    confidence: number;
  };

  /** Этап 4: Верификация */
  stage_4_verification: {
    /** Проверка: соответствует ли выбор контексту */
    context_consistent: boolean;
    /** Проверка: нет ли противоречивых сигналов */
    no_conflicting_signals: boolean;
    /** Финальный вердикт */
    final_verdict: {
      type: 'chat' | 'document';
      confidence: number;
      reasoning: string;
    };
  };
}

/**
 * SGR-промпт для детерминированной классификации намерений
 */
function buildSgrIntentPrompt(
  conversationContext: string,
  lastUserMessage: string,
  systemInstructions: string
): string {
  return `ТЫ — AI-классификатор намерений в системе создания протоколов обследования.
Твоя задача — определить намерение пользователя с использованием Schema-Guided Reasoning (SGR).

================================================================================
## КОНТЕКСТ СИСТЕМЫ
================================================================================

Система работает в 2 этапа:
1. **Диалог (chat)**: сбор информации через уточняющие вопросы
2. **Документ (document)**: формирование финального протокола

**ИНСТРУКЦИИ ДЛЯ АССИСТЕНТА:**
${systemInstructions}

================================================================================
## ИСТОРИЯ ДИАЛОГА
================================================================================

${conversationContext}

================================================================================
## ПОСЛЕДНЕЕ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ
================================================================================

"${lastUserMessage}"

================================================================================
## SGR-СХЕМА КЛАССИФИКАЦИИ (4 ОБЯЗАТЕЛЬНЫХ ЭТАПА)
================================================================================

================================================================================
### ЭТАП 1: АНАЛИЗ КОНТЕКСТА ДИАЛОГА
================================================================================

**ЗАДАЧА:** Определить стадию диалога и контекст

**ДЕЙСТВИЯ:**
1. Подсчитать количество сообщений в истории
2. Проверить наличие загруженных файлов
3. Проверить наличие существующего документа
4. Определить стадию диалога:
   - **greeting**: первое сообщение, приветствие
   - **information_gathering**: сбор информации, уточняющие вопросы
   - **clarification**: уточнение деталей, промежуточные подтверждения
   - **finalization**: завершение сбора, готовность к документу

**КРИТЕРИИ СТАДИЙ:**
- greeting: сообщений ≤ 2, нет файлов, нет расшифровки
- information_gathering: пользователь отвечает на вопросы, предоставляет информацию
- clarification: промежуточные подтверждения ("верно", "да", "согласен")
- finalization: явная готовность к документу, подтверждение завершённости

**ФОРМАТ ВЫВОДА ЭТАПА 1:**
\`\`\`json
{
  "stage_1_context_analysis": {
    "message_count": 5,
    "has_attachments": false,
    "has_existing_document": true,
    "conversation_stage": "clarification"
  }
}
\`\`\`

================================================================================
### ЭТАП 2: АНАЛИЗ ПОСЛЕДНЕГО СООБЩЕНИЯ
================================================================================

**ЗАДАЧА:** Проанализировать последнее сообщение пользователя

**ДЕЙСТВИЯ:**
1. Очистить текст от вложений и служебных маркеров
2. Извлечь ключевые слова-маркеры
3. Проверить наличие команд на генерацию документа
4. Проверить наличие подтверждений готовности
5. Проверить наличие запросов на уточнение

**МАРКЕРЫ ДЛЯ "document":**
- "покажи протокол", "создай документ", "сформируй протокол"
- "исправь документ", "отредактируй протокол" (с конкретными указаниями)
- "готово", "вся информация собрана", "можно формировать"
- Подтверждение после предложения ассистента о готовности к документу

**МАРКЕРЫ ДЛЯ "chat":**
- Ответы на уточняющие вопросы
- Предоставление дополнительной информации
- Запросы вопросов ("а что дальше?", "как это работает?")
- Загрузка файлов без текста
- Промежуточные подтверждения ("верно", "да", "согласен")

**ФОРМАТ ВЫВОДА ЭТАПА 2:**
\`\`\`json
{
  "stage_2_message_analysis": {
    "cleaned_text": "Да, всё верно",
    "keywords": ["да", "верно"],
    "has_document_command": false,
    "has_readiness_confirmation": false,
    "has_clarification_request": false
  }
}
\`\`\`

================================================================================
### ЭТАП 3: ROUTING — ВЫБОР ПУТИ
================================================================================

**ЗАДАЧА:** Выбрать между chat и document на основе анализа

**ПРАВИЛА ВЫБОРА:**

**Выбирай "document" ЕСЛИ:**
- Пользователь явно просит показать/создать итоговый протокол
- Пользователь даёт команду на формирование документа
- Пользователь просит изменить документ с конкретными указаниями
- Пользователь подтверждает готовность ПОСЛЕ предложения ассистента
- Контекст показывает завершение сбора информации + финальное подтверждение

**Выбирай "chat" ЕСЛИ:**
- Пользователь отвечает на уточняющие вопросы
- Пользователь предоставляет дополнительную информацию
- Пользователь задаёт вопросы
- Пользователь загружает файлы
- Идёт процесс обсуждения деталей
- Промежуточные подтверждения во время сбора информации
- Сбор информации ещё не завершён

**ФОРМАТ ВЫВОДА ЭТАПА 3:**
\`\`\`json
{
  "stage_3_routing": {
    "arguments_for_document": ["Пользователь подтвердил готовность"],
    "arguments_for_chat": ["Сбор информации ещё не завершён"],
    "selected_route": "document",
    "confidence": 0.85
  }
}
\`\`\`

================================================================================
### ЭТАП 4: ВЕРИФИКАЦИЯ
================================================================================

**ЗАДАЧА:** Проверить корректность выбора

**ПРОВЕРОЧНЫЕ ВОПРОСЫ:**
1. Соответствует ли выбор контексту диалога?
2. Нет ли противоречивых сигналов?
3. Достаточна ли уверенность для выбора?
4. Учтены ли все маркеры?

**ДЕЙСТВИЯ:**
1. Подтвердить выбор или пересмотреть при противоречиях
2. Сформулировать reasoning для финального вердикта
3. Указать уверенность (0.0-1.0)

**ФОРМАТ ВЫВОДА ЭТАПА 4:**
\`\`\`json
{
  "stage_4_verification": {
    "context_consistent": true,
    "no_conflicting_signals": true,
    "final_verdict": {
      "type": "document",
      "confidence": 0.85,
      "reasoning": "Пользователь явно подтвердил готовность к формированию протокола после завершения сбора информации"
    }
  }
}
\`\`\`

================================================================================
## ТРЕБОВАНИЯ К ВЫВОДУ (КРИТИЧЕСКИ ВАЖНО)
================================================================================

1. **ВЫВОДИТЕ ПОЛНУЮ SGR-СХЕМУ** — все 4 этапа в формате JSON
2. **КАЖДЫЙ ЭТАП** должен быть завершен перед переходом к следующему
3. **АНАЛИЗИРОВАТЬ ВЕСЬ КОНТЕКСТ** — не только последнее сообщение
4. **УЧИТЫВАТЬ СТАДИЮ** — промежуточные подтверждения ≠ готовность к документу
5. **ДЕТЕРМИНИРОВАННОСТЬ** — одинаковый контекст → одинаковый выбор

================================================================================
## ФОРМАТ ОТВЕТА
================================================================================

Отвечай ТОЛЬКО валидным JSON без Markdown, без блоков кода, без комментариев.
Формат: полная SGR-схема из 4 этапов.

================================================================================
## НАЧИНАЙТЕ SGR-КЛАССИФИКАЦИЮ. ВЫВОДИТЕ ПОЛНУЮ СХЕМУ ВСЕХ 4 ЭТАПОВ.
================================================================================`;
}

function stripAttachmentNoise(text: string): string {
  if (!text) return '';
  return String(text)
    .replace(/\n---\nВложенный файл:[\s\S]*?\n---/g, '')
    .replace(/<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi, '')
    .trim();
}

function contentToText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p?.text === 'string') return p.text;
        if (typeof p?.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object') {
    if (typeof (content as any).text === 'string') return (content as any).text;
    if (typeof (content as any).content === 'string') return (content as any).content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function uiMessageText(msg: any): string {
  if (!msg) return '';
  if (Array.isArray(msg?.parts)) {
    const t = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string')?.text;
    if (t) return String(t);
  }
  if (typeof msg?.content === 'string') return msg.content;
  if (typeof msg?.text === 'string') return msg.text;
  return '';
}

function getLastUserTextForIntent(context: AgentContext): string {
  const uiMessages: any[] = Array.isArray((context as any).uiMessages) ? ((context as any).uiMessages as any[]) : [];
  if (uiMessages.length > 0) {
    const lastUiUser = [...uiMessages].reverse().find((m) => m?.role === 'user');
    const text = stripAttachmentNoise(uiMessageText(lastUiUser));
    return text;
  }

  const msgs: any[] = Array.isArray((context as any).messages) ? ((context as any).messages as any[]) : [];
  const last = msgs[msgs.length - 1];
  const raw = contentToText(last?.content);
  const text = stripAttachmentNoise(raw);
  return text;
}

export async function classifyIntent(context: AgentContext): Promise<IntentType> {
  const { messages, userPrompt, model } = context;

  const conversationContext = messages.slice(-12);
  const lastUserText = getLastUserTextForIntent(context);

  try {
    // Используем SGR-промпт для детерминированной классификации
    const sgrIntentPrompt = buildSgrIntentPrompt(
      conversationContext.map((msg, i) => {
        const content = contentToText((msg as any).content);
        return `[${i + 1}] ${msg.role}: ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`;
      }).join('\n\n'),
      lastUserText,
      userPrompt || ''
    );

    const { text: rawOutput } = await generateText({
      model,
      temperature: 0.1,
      prompt: sgrIntentPrompt,
    });

    const rawText = String(rawOutput ?? '').trim();
    console.log('🤖 Raw SGR Intent Classification Output:', rawText.substring(0, 500) + '...');

    if (!rawText) {
      console.warn('⚠️ Empty classifier response, defaulting to chat');
      return 'chat';
    }

    let cleanJson = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    }

    console.log('📝 Cleaned JSON for parsing:', cleanJson.substring(0, 200));

    if (!cleanJson || cleanJson.length < 5 || firstBrace === -1) {
      console.warn('⚠️ Empty or invalid classifier response, defaulting to chat');
      return 'chat';
    }

    // Пытаемся распарсить полный SGR-ответ
    let sgrResponse: any;
    try {
      sgrResponse = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.warn('Failed to parse SGR JSON, defaulting to chat.', parseErr);
      return 'chat';
    }

    // Извлекаем результат из stage_4_verification.final_verdict
    let intentType: IntentType = 'chat';
    let confidence = 0.5;
    let reasoning = '';

    if (sgrResponse.stage_4_verification?.final_verdict) {
      intentType = sgrResponse.stage_4_verification.final_verdict.type as IntentType;
      confidence = sgrResponse.stage_4_verification.final_verdict.confidence;
      reasoning = sgrResponse.stage_4_verification.final_verdict.reasoning;
    } else if (sgrResponse.stage_3_routing?.selected_route) {
      // Fallback к stage_3_routing
      intentType = sgrResponse.stage_3_routing.selected_route as IntentType;
      confidence = sgrResponse.stage_3_routing.confidence;
      reasoning = `Выбран путь: ${intentType}`;
    } else if (sgrResponse.type) {
      // Fallback к старому формату
      intentType = sgrResponse.type as IntentType;
      confidence = sgrResponse.confidence;
      reasoning = sgrResponse.reasoning || '';
    }

    // Валидация типа
    if (intentType !== 'chat' && intentType !== 'document') {
      intentType = 'chat';
    }

    console.log('🤖 SGR Intent classification:', {
      type: intentType,
      confidence,
      reasoning
    });

    return intentType as IntentType;
  } catch (err) {
    console.error('Intent classification failed:', err);
    return 'chat';
  }
}