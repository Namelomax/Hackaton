import { createUIMessageStream, JsonToSseTransformStream, streamObject } from 'ai';
import { AgentContext } from './types';
import { updateConversation, saveConversation } from '@/lib/getPromt';
import { ProtocolSchema, type Protocol } from '@/lib/schemas/protocol-schema';
import { generateProtocolDocx } from '@/lib/docx-generator';

/**
 * SGR-схема для детерминированной генерации протокола (Schema-Guided Reasoning)
 * Применяет паттерны: Cascade (пошаговое заполнение), Cycle (проверка каждого раздела),
 * Verification (верификация полноты данных)
 */
interface SgrProtocolGenerationSchema {
  /** Этап 1: Анализ исходных данных */
  stage_1_data_analysis: {
    /** Источник данных */
    data_source: 'transcript_only' | 'document_only' | 'transcript_and_document';
    /** Извлечённые факты из расшифровки */
    facts_from_transcript: string[];
    /** Данные из существующего документа (если есть) */
    data_from_document: string[];
    /** Выявленные противоречия между источниками */
    conflicts: string[];
    /** Отсутствующая информация (критические пробелы) */
    missing_critical_data: string[];
  };

  /** Этап 2: Cascade - Проверка структуры (10 обязательных разделов) */
  stage_2_structure_cascade: {
    /** Проверка каждого раздела на наличие данных */
    sections_check: Array<{
      section_number: number;
      section_name: string;
      has_data: boolean;
      data_completeness: 'complete' | 'partial' | 'missing';
      source: 'transcript' | 'document' | 'both' | 'inferred';
    }>;
    /** Разделы с отсутствующими данными */
    sections_with_missing_data: number[];
  };

  /** Этап 3: Cycle - Детальная проверка каждого раздела */
  stage_3_section_cycle: {
    /** Проверка раздела 1: Дата и номер */
    section_1_check: {
      meeting_date_format_valid: boolean;
      protocol_number_present: boolean;
    };
    /** Проверка раздела 3: Участники */
    section_3_check: {
      customer_people_count: number;
      executor_people_count: number;
      all_have_full_names: boolean;
      all_have_positions: boolean;
    };
    /** Проверка раздела 8: Решения */
    section_8_check: {
      decisions_count: number;
      all_have_responsible: boolean;
    };
    /** Проверка стиля и формата */
    style_check: {
      business_style: boolean;
      no_hypothetical_phrases: boolean;
      no_example_only_data: boolean;
    };
  };

  /** Этап 4: Верификация и консолидация */
  stage_4_verification: {
    /** Все ли 10 разделов заполнены */
    all_sections_present: boolean;
    /** Все ли ответственные указаны */
    all_responsibles_present: boolean;
    /** Все ли ФИО полные */
    all_names_complete: boolean;
    /** Сохранён ли деловой стиль */
    business_style_preserved: boolean;
    /** Выявленные проблемы */
    identified_issues: string[];
    /** Принятые решения по заполнению пробелов */
    gap_filling_decisions: string[];
  };

  /** Этап 5: Формирование ответа */
  stage_5_output: {
    /** Сгенерированный протокол */
    protocol: Protocol;
    /** Статус генерации */
    generation_status: 'success' | 'partial' | 'failed';
    /** Предупреждения (неблокирующие проблемы) */
    warnings: string[];
  };
}

/**
 * SGR-промпт для детерминированной генерации протокола
 * Применяет Schema-Guided Reasoning для точного извлечения данных
 */
function buildSgrProtocolPrompt(
  conversationContext: string,
  existingDocumentContext: string
): string {
  return `ТЫ — AI-эксперт по генерации протоколов обследования. Твоя задача — создать структурированный протокол с использованием Schema-Guided Reasoning (SGR).

================================================================================
## ИСХОДНЫЕ ДАННЫЕ
================================================================================

**РАСШИФРОВКА ВСТРЕЧИ:**
"""
${conversationContext}
"""

${existingDocumentContext}

================================================================================
## SGR-СХЕМА ГЕНЕРАЦИИ ПРОТОКОЛА (5 ОБЯЗАТЕЛЬНЫХ ЭТАПОВ)
================================================================================

ВЫ ПОШАГОВО ПРОХОДИТЕ ВСЕ 5 ЭТАПОВ. КАЖДЫЙ ЭТАП — ОБЯЗАТЕЛЬНЫЙ CHECKPOINT.
НЕ ПЕРЕХОДИТЕ К СЛЕДУЮЩЕМУ ЭТАПУ, ПОКА НЕ ЗАВЕРШИТЕ ПРЕДЫДУЩИЙ.

================================================================================
### ЭТАП 1: АНАЛИЗ ИСХОДНЫХ ДАННЫХ
================================================================================

**ЗАДАЧА:** Извлечь все факты из расшифровки и существующего документа

**ДЕЙСТВИЯ:**
1. Прочитать расшифровку встречи ПОЛНОСТЬЮ
2. Извлечь ВСЕ факты для каждого из 10 разделов протокола
3. Если есть существующий документ — извлечь данные из него
4. Выявить противоречия между источниками (если есть)
5. Зафиксировать отсутствующую критическую информацию

**ПРАВИЛА ИЗВЛЕЧЕНИЯ ДАННЫХ:**
- Использовать ТОЛЬКО факты из расшифровки
- НЕ включать гипотетические формулировки ("например", "может быть", "возможно")
- НЕ включать данные, упомянутые только как примеры
- Если информация отсутствует — явно указать "Информация не предоставлена"
- При противоречиях — выбрать более позднюю информацию (если не указано иное)

**КРИТИЧЕСКИ ВАЖНЫЕ ДАННЫЕ (должны быть извлечены):**
- Дата встречи (формат: ДД.ММ.ГГГГ)
- Номер протокола
- Полные ФИО всех участников (минимум фамилия + имя)
- Должности всех участников
- Ответственные за каждое решение

**ФОРМАТ ВЫВОДА ЭТАПА 1:**
\`\`\`json
{
  "stage_1_data_analysis": {
    "data_source": "transcript_and_document",
    "facts_from_transcript": ["Дата: 07.04.2026", "Участники: 4 человека"],
    "data_from_document": ["Номер протокола: №5"],
    "conflicts": ["В расшифровке дата 07.04.2026, в документе 08.04.2026"],
    "missing_critical_data": ["Отчество у участника Иванов"]
  }
}
\`\`\`

================================================================================
### ЭТАП 2: CASCADE — ПРОВЕРКА СТРУКТУРЫ (10 РАЗДЕЛОВ)
================================================================================

**ЗАДАЧА:** Проверить наличие данных для каждого из 10 разделов

**ОБЯЗАТЕЛЬНЫЕ РАЗДЕЛЫ:**
1. Номер протокола и дата встречи
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
1. Для КАЖДОГО раздела проверить наличие данных
2. Оценить полноту данных: complete/partial/missing
3. Указать источник данных: transcript/document/both/inferred
4. Зафиксировать разделы с отсутствующими данными

**ФОРМАТ ВЫВОДА ЭТАПА 2:**
\`\`\`json
{
  "stage_2_structure_cascade": {
    "sections_check": [
      {"section_number": 1, "section_name": "Дата и номер", "has_data": true, "data_completeness": "complete", "source": "transcript"},
      {"section_number": 3, "section_name": "Участники", "has_data": true, "data_completeness": "partial", "source": "both"}
    ],
    "sections_with_missing_data": [5]
  }
}
\`\`\`

================================================================================
### ЭТАП 3: CYCLE — ДЕТАЛЬНАЯ ПРОВЕРКА КАЖДОГО РАЗДЕЛА
================================================================================

**ЗАДАЧА:** Детальная проверка критических разделов

**3.1. ПРОВЕРКА РАЗДЕЛА 1 (Дата и номер):**
- Дата в формате ДД.ММ.ГГГГ?
- Номер протокола присутствует?

**3.2. ПРОВЕРКА РАЗДЕЛА 3 (Участники):**
- Все ли участники имеют полные ФИО (минимум фамилия + имя)?
- Все ли участники имеют должности?
- Количество участников соответствует расшифровке?

**3.3. ПРОВЕРКА РАЗДЕЛА 8 (Решения):**
- Все ли решения имеют ответственного?
- Ответственный указан конкретно (ФИО или сторона)?

**3.4. ПРОВЕРКА СТИЛЯ И ФОРМАТА:**
- Сохранён ли деловой стиль?
- Отсутствуют ли гипотетические фразы ("например", "может быть")?
- Отсутствуют ли данные, упомянутые только как примеры?

**ФОРМАТ ВЫВОДА ЭТАПА 3:**
\`\`\`json
{
  "stage_3_section_cycle": {
    "section_1_check": {
      "meeting_date_format_valid": true,
      "protocol_number_present": true
    },
    "section_3_check": {
      "customer_people_count": 2,
      "executor_people_count": 2,
      "all_have_full_names": false,
      "all_have_positions": true
    },
    "section_8_check": {
      "decisions_count": 3,
      "all_have_responsible": true
    },
    "style_check": {
      "business_style": true,
      "no_hypothetical_phrases": true,
      "no_example_only_data": true
    }
  }
}
\`\`\`

================================================================================
### ЭТАП 4: ВЕРИФИКАЦИЯ И КОНСОЛИДАЦИЯ
================================================================================

**ЗАДАЧА:** Финальная проверка перед генерацией

**ПРОВЕРОЧНЫЕ ВОПРОСЫ:**
1. Все ли 10 разделов имеют данные?
2. Все ли решения имеют ответственных?
3. Все ли ФИО полные (минимум фамилия + имя)?
4. Сохранён ли деловой стиль?
5. Отсутствуют ли гипотетические данные?

**ДЕЙСТВИЯ ПРИ ОБНАРУЖЕНИИ ПРОБЕЛОВ:**
- Если раздел пуст — указать "Информация не предоставлена"
- Если нет ответственного — указать "Требуется уточнение"
- Если ФИО неполное — использовать имеющиеся данные, добавить предупреждение

**ФОРМАТ ВЫВОДА ЭТАПА 4:**
\`\`\`json
{
  "stage_4_verification": {
    "all_sections_present": true,
    "all_responsibles_present": true,
    "all_names_complete": false,
    "business_style_preserved": true,
    "identified_issues": ["Неполное ФИО у участника Екатерина"],
    "gap_filling_decisions": ["Раздел 5 заполнен как 'Информация не предоставлена'"]
  }
}
\`\`\`

================================================================================
### ЭТАП 5: ФОРМИРОВАНИЕ ОТВЕТА
================================================================================

**ЗАДАЧА:** Сгенерировать финальный протокол в соответствии со схемой

**ТРЕБОВАНИЯ:**
1. Использовать ТОЛЬКО подтверждённые данные из Этапа 1-4
2. Заполнить ВСЕ 10 разделов
3. Для отсутствующих данных указать "Информация не предоставлена"
4. Сохранить деловой стиль
5. НЕ включать гипотетические формулировки

**ФОРМАТ ФИНАЛЬНОГО ОТВЕТА:**
\`\`\`json
{
  "stage_5_output": {
    "protocol": { ... Protocol Schema ... },
    "generation_status": "success",
    "warnings": ["Неполное ФИО у участника Екатерина"]
  }
}
\`\`\`

================================================================================
## ТРЕБОВАНИЯ К ВЫВОДУ (КРИТИЧЕСКИ ВАЖНО)
================================================================================

1. **ВЫВОДИТЕ ПОЛНУЮ SGR-СХЕМУ** — все 5 этапов в формате JSON
2. **КАЖДЫЙ ЭТАП** должен быть завершен перед переходом к следующему
3. **НЕ ИМПРОВИЗИРОВАТЬ** — использовать только факты из расшифровки
4. **ЗАПОЛНИТЬ ВСЕ 10 РАЗДЕЛОВ** — даже если данные отсутствуют
5. **ДЕТЕРМИНИРОВАННОСТЬ** — одинаковая расшифровка → одинаковый протокол

================================================================================
## НАЧИНАЙТЕ SGR-ГЕНЕРАЦИЮ. ВЫВОДИТЕ ПОЛНУЮ СХЕМУ ВСЕХ 5 ЭТАПОВ.
================================================================================`;
}

function extractMessageText(msg: any): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg?.parts)) {
    const texts = msg.parts
      .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean);
    if (texts.length) return texts.join(' ');
  }
  if (msg?.content && typeof msg.content === 'object') {
    try {
      return JSON.stringify(msg.content);
    } catch (e) {
      return String(msg.content);
    }
  }
  return '';
}

function coerceProtocol(partial: Partial<Protocol>): Protocol {
  const toString = (value: any) => (value == null ? '' : String(value));
  const toArray = <T>(value: any): T[] => (Array.isArray(value) ? value : []);
  const toPeople = (value: any) =>
    toArray(value).map((p: any) => ({
      fullName: toString(p?.fullName || p?.name),
      position: toString(p?.position || p?.role),
    }));

  return {
    protocolNumber: toString(partial.protocolNumber),
    meetingDate: toString(partial.meetingDate),
    agenda: {
      title: toString(partial.agenda?.title),
      items: toArray<string>(partial.agenda?.items).map(toString),
    },
    participants: {
      customer: {
        organizationName: toString(partial.participants?.customer?.organizationName),
        people: toPeople(partial.participants?.customer?.people),
      },
      executor: {
        organizationName: toString(partial.participants?.executor?.organizationName),
        people: toPeople(partial.participants?.executor?.people),
      },
    },
    termsAndDefinitions: toArray(partial.termsAndDefinitions).map((item: any) => ({
      term: toString(item?.term),
      definition: toString(item?.definition),
    })),
    abbreviations: toArray(partial.abbreviations).map((item: any) => ({
      abbreviation: toString(item?.abbreviation),
      fullForm: toString(item?.fullForm),
    })),
    meetingContent: {
      introduction: toString(partial.meetingContent?.introduction || ''),
      topics: toArray(partial.meetingContent?.topics).map((topic: any) => ({
        title: toString(topic?.title),
        content: toString(topic?.content),
        subtopics: toArray(topic?.subtopics).map((sub: any) => ({
          title: toString(sub?.title || ''),
          content: toString(sub?.content),
        })),
      })),
      migrationFeatures: toArray(partial.meetingContent?.migrationFeatures).map((feat: any) => ({
        tab: toString(feat?.tab),
        features: toString(feat?.features),
      })),
    },
    questionsAndAnswers: toArray(partial.questionsAndAnswers).map((qa: any) => ({
      question: toString(qa?.question),
      answer: toString(qa?.answer),
    })),
    decisions: toArray(partial.decisions).map((decision: any) => ({
      decision: toString(decision?.decision),
      responsible: toString(decision?.responsible),
    })),
    openQuestions: toArray<string>(partial.openQuestions).map(toString),
    approval: {
      executorSignature: {
        organization: toString(partial.approval?.executorSignature?.organization),
        representative: toString(partial.approval?.executorSignature?.representative),
      },
      customerSignature: {
        organization: toString(partial.approval?.customerSignature?.organization),
        representative: toString(partial.approval?.customerSignature?.representative),
      },
    },
  };
}

function stripTimecodeMarkers(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\}\}/gi, '')
    .replace(/\[TC:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runDocumentAgent(context: AgentContext) {
  const { messages, uiMessages, model, userPrompt, documentContent, userId, conversationId } = context;
  let generatedDocumentContent = '';

  const safeOriginalUIMessages = (() => {
    if (Array.isArray(uiMessages) && uiMessages.length > 0) return uiMessages as any;
    // Minimal fallback shape expected by `createUIMessageStream`.
    return (Array.isArray(messages) ? messages : []).map((m: any, idx: number) => {
      const text = typeof m?.content === 'string' ? m.content : '';
      return {
        id: String(m?.id ?? `m-${idx}-${Date.now()}`),
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        parts: [{ type: 'text', text }],
        metadata: m?.metadata ?? {},
      };
    });
  })();

  const stream = createUIMessageStream({
    originalMessages: safeOriginalUIMessages,
    execute: async ({ writer }) => {
      try {
        generatedDocumentContent = await generateFinalDocument(
          messages,
          userPrompt,
          writer,
          model,
          documentContent,
          conversationId
        );
      } catch (error) {
        console.error('Document generation error:', error);
        writer.write({ type: 'text-start', id: 'error' });
        writer.write({
          type: 'text-delta',
          id: 'error',
          delta: 'Произошла ошибка при формировании документа. Попробуйте снова.',
        });
        writer.write({ type: 'text-end', id: 'error' });
      }
    },
    onFinish: async ({ messages: finished }) => {
      if (userId) {
        try {
          if (conversationId) {
            await updateConversation(conversationId, finished, generatedDocumentContent);
          } else {
            await saveConversation(userId, finished, generatedDocumentContent);
          }
        } catch (e) {
          console.error('document persistence failed', e);
        }
      }
    }
  });

  const readable = stream.pipeThrough(new JsonToSseTransformStream());
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function generateFinalDocument(
  messages: any[],
  userPrompt: string | null,
  dataStream: any,
  model: any,
  existingDocument?: string,
  conversationId?: string | null,
  temperature: number = 0.1,
): Promise<string> {
  const writeData = (payload: { type: string; data: any; id?: string; transient?: boolean }) => {
    dataStream.write({
      type: payload.type,
      data: payload.data,
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.transient ? { transient: payload.transient } : {}),
    });
  };


  // Извлекаем всю историю диалога (расшифровку встречи)
  const conversationContext = messages
    .map((msg) => {
      const text = extractMessageText(msg);
      const cleaned = stripTimecodeMarkers(text);
      return cleaned ? `${msg.role}: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Подготовка контекста существующего документа (если есть ручные правки)
  const existingDocumentContext = existingDocument && existingDocument.trim()
    ? `\n\nСУЩЕСТВУЮЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n"""\n${existingDocument}\n"""\n\n`
    : '';

  const progressId = `protocol-${crypto.randomUUID()}`;
  dataStream.write({ type: 'text-start', id: progressId });

  dataStream.write({
    type: 'text-delta',
    id: progressId,
    delta: '📝 Формирование протокола обследования\n',
  });

  // Используем SGR-промпт для детерминированной генерации
  const sgrProtocolPrompt = buildSgrProtocolPrompt(conversationContext, existingDocumentContext);

  let protocol: Protocol | null = null;
  let markdownContent = '';

  try {
    const { partialObjectStream } = streamObject({
      model,
      temperature,
      schema: ProtocolSchema,
      prompt: sgrProtocolPrompt,
    });

    let lastMarkdown = '';
    let lastTitle = '';

    for await (const partial of partialObjectStream) {
      const safeProtocol = coerceProtocol(partial as Partial<Protocol>);
      protocol = safeProtocol;

      let nextMarkdown = '';
      try {
        nextMarkdown = protocolToMarkdown(safeProtocol);
      } catch {
        continue;
      }

      if (!nextMarkdown || nextMarkdown === lastMarkdown) continue;

      if (safeProtocol.protocolNumber) {
        const nextTitle = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${safeProtocol.protocolNumber}`.trim();
        if (nextTitle && nextTitle !== lastTitle) {
          writeData({ type: 'data-title', data: nextTitle, transient: true });
          lastTitle = nextTitle;
        }
      }

      writeData({ type: 'data-clear', data: null, transient: true });
      writeData({ type: 'data-documentDelta', data: nextMarkdown, transient: true });

      lastMarkdown = nextMarkdown;
      markdownContent = nextMarkdown;
    }

    writeData({ type: 'data-finish', data: null, transient: true });

    if (!protocol) {
      throw new Error('Failed to generate protocol');
    }

    const docxBuffer = await generateProtocolDocx(protocol);
    const base64Docx = docxBuffer.toString('base64');
    writeData({
      type: 'data-docx',
      data: {
        content: base64Docx,
        filename: `Протокол_обследования_${protocol.protocolNumber.replace(/[^0-9]/g, '')}_${protocol.meetingDate.replace(/\./g, '-')}.docx`,
      },
    });
  } catch (error) {
    console.error('Protocol generation error:', error);
    dataStream.write({
      type: 'text-delta',
      id: progressId,
      delta: '❌ Ошибка при формировании протокола. Проверьте полноту данных в расшифровке.\n',
    });
    dataStream.write({ type: 'text-end', id: progressId });
    throw error;
  }

  dataStream.write({ type: 'text-end', id: progressId });
  return markdownContent;
}

function protocolToMarkdown(protocol: Protocol): string {
  const normalizedNumber = String(protocol.protocolNumber || '').trim().startsWith('№')
    ? String(protocol.protocolNumber).trim()
    : `№${String(protocol.protocolNumber || '').trim()}`;
  let md = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${normalizedNumber}\n\n`;

  md += `1.\tДата встречи: ${protocol.meetingDate}\n\n`;

  md += `2.\tПовестка: ${protocol.agenda.title}\n`;
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item) => {
      md += `- ${item}\n`;
    });
  }
  md += '\n\n';

  md += `3.\tУчастники:\n\n`;
  md += `**Со стороны Заказчика ${protocol.participants.customer.organizationName}:**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.customer.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n\n';
  md += `**Со стороны Исполнителя ${protocol.participants.executor.organizationName}:**\n\n`;
  md += '| ФИО | Должность/роль |\n';
  md += '| --- | --- |\n';
  protocol.participants.executor.people.forEach((p) => {
    md += `| ${p.fullName} | ${p.position} |\n`;
  });

  md += '\n\n';

  md += `4.\tТермины и определения:\n\n`;
  protocol.termsAndDefinitions.forEach((term) => {
    md += `- ${term.term} – ${term.definition}\n`;
  });

  md += '\n\n';

  md += `5.\tСокращения и обозначения:\n\n`;
  protocol.abbreviations.forEach((abbr) => {
    md += `- ${abbr.abbreviation} – ${abbr.fullForm}\n`;
  });

  md += '\n\n';

  md += `6.\tСодержание встречи:\n\n`;
  md += 'В ходе встречи обсуждались следующие вопросы:\n\n';
  if (protocol.meetingContent.introduction) {
    md += `${protocol.meetingContent.introduction}\n\n`;
  }
  protocol.meetingContent.topics.forEach((topic) => {
    md += `- ${topic.title}\n`;
    md += `  ${topic.content}\n`;
    if (topic.subtopics && topic.subtopics.length > 0) {
      topic.subtopics.forEach((sub) => {
        if (sub.title) {
          md += `  - ${sub.title}\n`;
        }
        md += `    ${sub.content}\n`;
      });
    }
  });
  md += '\n\n';
  if (protocol.meetingContent.migrationFeatures && protocol.meetingContent.migrationFeatures.length > 0) {
    md += '| Вкладка | Особенности |\n';
    md += '| --- | --- |\n';
    protocol.meetingContent.migrationFeatures.forEach((feat) => {
      md += `| ${feat.tab} | ${feat.features} |\n`;
    });
    md += '\n';
  }

  md += '\n\n';

  md += `7.\tВопросы:\n\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `- ${i + 1}. ${qa.question}\n`;
  });

  // 3 пустые строки для разрыва между списками
  md += '\n\n\n';
  md += `**Ответы**:\n\n`;
  protocol.questionsAndAnswers.forEach((qa, i) => {
    md += `- ${i + 1}. ${qa.answer}\n`;
  });

  md += '\n\n\n';

  md += `8.\tРешения:\n\n`;
  protocol.decisions.forEach((decision, i) => {
    md += `- ${i + 1}. ${decision.decision}\n`;
    md += `  Ответственный: ${decision.responsible}\n`;
  });

  md += '\n\n\n';

  md += `9.\tОткрытые вопросы:\n\n`;
  protocol.openQuestions.forEach((q, i) => {
    md += `- ${i + 1}. ${q}\n`;
  });

  md += '\n\n\n';

  md += '10.\tСогласовано:\n\n';
  md += '| Со стороны Исполнителя | Со стороны Заказчика |\n';
  md += '| --- | --- |\n';
  md += `| ${protocol.approval.executorSignature.organization} | ${protocol.approval.customerSignature.organization} |\n`;
  md += `| ${protocol.approval.executorSignature.representative} /______________ | ${protocol.approval.customerSignature.representative} /______________ |\n`;
  md += '\n';

  return md;
}
