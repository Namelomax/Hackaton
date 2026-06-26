import { generateText } from 'ai';
import type { Protocol } from '@/lib/schemas/protocol-schema';

export interface SectionCheck {
  section: string;
  hasIssues: boolean;
  issues: string;
}

const MAX_CONV_CHARS_PER_CHUNK = 8000;

function trimConversation(conv: string): string {
  if (conv.length <= MAX_CONV_CHARS_PER_CHUNK) return conv;
  // Берём последние MAX_CONV_CHARS_PER_CHUNK символов — там финальные подтверждения
  return '...(начало опущено)...\n' + conv.slice(-MAX_CONV_CHARS_PER_CHUNK);
}

function buildVerifyPrompt(sectionName: string, sectionContent: string, conversation: string): string {
  return `Ты — контролёр точности протокола. Проверь, соответствует ли раздел «${sectionName}» истории диалога.

РАЗДЕЛ ПРОТОКОЛА:
"""
${sectionContent}
"""

ИСТОРИЯ ДИАЛОГА (расшифровка встречи + переписка агента с пользователем):
"""
${conversation}
"""

Ответь ТОЛЬКО одним из двух вариантов:
- Если раздел корректен: ответь ровно "OK"
- Если есть проблемы (пропущены данные из диалога, нарушены правки пользователя, ошибочные факты): перечисли кратко, одна строка на проблему. Без объяснений и вводных слов.`;
}

type VerifySection = { name: string; content: string };

function buildSections(protocol: Protocol): VerifySection[] {
  const sections: VerifySection[] = [];

  // Повестка
  const agendaText = protocol.agenda.items.length > 0
    ? protocol.agenda.items.map((item, i) => `${i + 1}) ${item}`).join('\n')
    : '(пусто)';
  sections.push({ name: 'Повестка', content: agendaText });

  // Участники
  const custPeople = protocol.participants.customer.people
    .map((p) => `  - ${p.fullName} (${p.position})`).join('\n');
  const execPeople = protocol.participants.executor.people
    .map((p) => `  - ${p.fullName} (${p.position})`).join('\n');
  sections.push({
    name: 'Участники',
    content: [
      `Заказчик: ${protocol.participants.customer.organizationName}`,
      custPeople || '  (нет данных)',
      `Исполнитель: ${protocol.participants.executor.organizationName}`,
      execPeople || '  (нет данных)',
    ].join('\n'),
  });

  // Содержание встречи — по одному топику за раз (самый вероятный источник ошибок)
  protocol.meetingContent.topics.forEach((t, i) => {
    sections.push({
      name: `Содержание встречи — тема ${i + 1}: «${t.title}»`,
      content: [
        `Слушали: ${t.listened}`,
        `Обсудили: ${t.discussed}`,
        `Решили: ${t.decided}`,
      ].join('\n'),
    });
  });

  // Согласование
  sections.push({
    name: 'Согласование (раздел 5)',
    content: [
      `Заказчик (${protocol.approval.customer.organization}): ${protocol.approval.customer.signatories.join(', ') || 'нет подписантов'}`,
      `Исполнитель (${protocol.approval.executor.organization}): ${protocol.approval.executor.signatories.join(', ') || 'нет подписантов'}`,
    ].join('\n'),
  });

  return sections;
}

/**
 * Проверяет каждый раздел итогового протокола на соответствие истории диалога.
 * Каждый раздел — отдельный LLM-запрос (чанкование).
 * Управляется переменной окружения ENABLE_PROTOCOL_VERIFY=true.
 */
export async function verifyProtocolSections(
  protocol: Protocol,
  conversationContext: string,
  model: any,
  abortSignal?: AbortSignal,
): Promise<SectionCheck[]> {
  const convSnippet = trimConversation(conversationContext);
  const sections = buildSections(protocol);
  const results: SectionCheck[] = [];

  for (const section of sections) {
    try {
      const { text } = await generateText({
        model,
        temperature: 0.1,
        maxOutputTokens: 256,
        prompt: buildVerifyPrompt(section.name, section.content, convSnippet),
        ...(abortSignal ? { abortSignal } : {}),
      });

      const trimmed = (text ?? '').trim();
      const hasIssues = !trimmed.startsWith('OK') && trimmed.length > 2;
      results.push({ section: section.name, hasIssues, issues: hasIssues ? trimmed : '' });
    } catch (err) {
      // Верификация некритична — пропускаем при ошибке
      console.warn(`[verify] "${section.name}" — пропущено:`, err);
    }
  }

  return results;
}
