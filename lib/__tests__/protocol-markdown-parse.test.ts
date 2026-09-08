import { buildProtocolBodyXml } from '@/lib/docx-template/protocol-body';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { protocolToMarkdown } from '../protocol-markdown-format';
import { markdownToProtocol } from '../protocol-markdown-parse';

/** Повторяет разметку маркеров из document-agent.markUnresolvedInMarkdown. */
function markUnresolved(md: string): string {
  return md
    .replace(/не указано в расшифровке/gi, '⚠️ не указано в расшифровке — требует уточнения')
    .replace(/⚠️\s*⚠️/g, '⚠️');
}

describe('markdownToProtocol', () => {
  it('вытаскивает шапку протокола', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.protocolNumber).toBe('№7');
    expect(parsed.meetingDate).toBe('12.01.2025');
    expect(parsed.protocolTitle).toBe('Обновление 1С:БГУ');
    expect(parsed.contractNumber).toBe('1122435346');
    expect(parsed.contractDate).toBe('30.12.2025');
    expect(parsed.contractSubject).toContain('Сопровождение ГИС');
  });

  it('разбирает повестку без хвостовых точек с запятой', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.agenda.items).toEqual([
      'Версия и дата обновления 1С:БГУ',
      'Регламент доступа к тестовому контуру',
    ]);
  });

  it('разбирает участников обеих сторон вместе с организациями', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.participants.customer.organizationName).toBe('ООО «Ромашка»');
    expect(parsed.participants.executor.people).toHaveLength(2);
    expect(parsed.participants.executor.people[0]).toEqual({
      fullName: 'Петров П.П.',
      position: 'Руководитель проекта',
    });
  });

  it('разбирает вопросы вместе со Слушали/Обсудили/Решили', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.meetingContent.topics).toHaveLength(2);
    expect(parsed.meetingContent.topics[0].listened).toBe('Иванов И.И., Петров П.П.');
    expect(parsed.meetingContent.topics[0].decided).toContain('Срок: 09.04.2025');
  });

  it('разбирает таблицу резюме, снимая <br> и жирный', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.meetingContent.summary).toHaveLength(1);
    expect(parsed.meetingContent.summary[0].question).toBe('Версия и дата обновления 1С:БГУ');
    expect(parsed.meetingContent.summary[0].decision).toContain('Срок: 09.04.2025');
    expect(parsed.meetingContent.summary[0].decision).not.toContain('<br>');
    expect(parsed.meetingContent.summary[0].decision).not.toContain('**');
  });

  it('разбирает подписантов, снимая линии для подписи', () => {
    const parsed = markdownToProtocol(protocolToMarkdown(SAMPLE_PROTOCOL));

    expect(parsed.approval.customer.signatories).toEqual(['Иванов И.И.']);
    expect(parsed.approval.executor.signatories).toEqual(['Петров П.П.', 'Сидоров С.С.']);
    expect(parsed.approval.customer.organization).toBe('ООО «Ромашка»');
  });

  it('не тащит в документ маркеры «требует уточнения»', () => {
    const parsed = markdownToProtocol(markUnresolved(protocolToMarkdown({
      ...SAMPLE_PROTOCOL,
      approval: {
        customer: { organization: '', signatories: [] },
        executor: { organization: '', signatories: [] },
      },
      participants: {
        customer: { organizationName: '', people: [] },
        executor: { organizationName: '', people: [] },
      },
    })));

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain('⚠️');
    expect(serialized).not.toContain('требует уточнения');
  });

  it('не падает на пустом вводе', () => {
    const parsed = markdownToProtocol('');

    expect(parsed.agenda.items).toEqual([]);
    expect(parsed.meetingContent.topics).toEqual([]);
  });
});

describe('круговой разбор', () => {
  const cases: Array<[string, typeof SAMPLE_PROTOCOL]> = [
    ['полный протокол', SAMPLE_PROTOCOL],
    [
      'без резюме',
      {
        ...SAMPLE_PROTOCOL,
        meetingContent: { ...SAMPLE_PROTOCOL.meetingContent, summary: [] },
      },
    ],
    [
      'без подписантов',
      {
        ...SAMPLE_PROTOCOL,
        approval: {
          customer: { organization: 'ООО «Ромашка»', signatories: [] },
          executor: { organization: 'ООО «Форус»', signatories: [] },
        },
      },
    ],
    [
      'разное число подписантов у сторон',
      {
        ...SAMPLE_PROTOCOL,
        approval: {
          customer: { organization: 'ООО «Ромашка»', signatories: ['Иванов И.И.'] },
          executor: {
            organization: 'ООО «Форус»',
            signatories: ['Петров П.П.', 'Сидоров С.С.', 'Кузнецов К.К.'],
          },
        },
      },
    ],
    [
      // B1: \s* перед группой даты в parsePreamble захватывал перенос строки и
      // "утекал" в заголовок протокола, когда дата собрания пуста.
      'пустая дата собрания',
      { ...SAMPLE_PROTOCOL, meetingDate: '' },
    ],
    [
      // B2: должность с переносом строки — ячейка таблицы участников должна
      // экранировать \n в <br>, а не терять вторую строку.
      'должность с переносом строки',
      {
        ...SAMPLE_PROTOCOL,
        participants: {
          ...SAMPLE_PROTOCOL.participants,
          customer: {
            ...SAMPLE_PROTOCOL.participants.customer,
            people: [{ fullName: 'Иванов И.И.', position: 'Главный\nбухгалтер' }],
          },
        },
      },
    ],
    [
      // B2: должность с | — без экранирования | ломает границы колонок таблицы.
      'должность с |',
      {
        ...SAMPLE_PROTOCOL,
        participants: {
          ...SAMPLE_PROTOCOL.participants,
          executor: {
            ...SAMPLE_PROTOCOL.participants.executor,
            people: [{ fullName: 'Петров П.П.', position: 'Директор | зам' }],
          },
        },
      },
    ],
    [
      // B3: formatApprovalOrgLine не идемпотентна — заглушка «не указано в
      // расшифровке», один раз попав в ячейку, на втором проходе получала
      // лишнее двоеточие. Обобщённые «Заказчик»/«Исполнитель» без названия
      // организации — самый частый путь получить эту заглушку.
      'обобщённые организации без явного названия',
      {
        ...SAMPLE_PROTOCOL,
        participants: {
          customer: { organizationName: '', people: SAMPLE_PROTOCOL.participants.customer.people },
          executor: { organizationName: '', people: SAMPLE_PROTOCOL.participants.executor.people },
        },
        approval: {
          customer: { organization: '', signatories: SAMPLE_PROTOCOL.approval.customer.signatories },
          executor: { organization: '', signatories: SAMPLE_PROTOCOL.approval.executor.signatories },
        },
      },
    ],
  ];

  it.each(cases)('%s: markdown → Protocol → та же вёрстка', (_name, protocol) => {
    const roundTripped = markdownToProtocol(protocolToMarkdown(protocol));

    expect(buildProtocolBodyXml(roundTripped)).toBe(buildProtocolBodyXml(protocol));
  });

  it('поле, начинающееся с «•» после ручной правки — маркер снимается как «-» и «*» (B4)', () => {
    // protocolToMarkdown пишет пункты через "- ", buildProtocolBodyXml рендерит их
    // через "• ". Пользователь, правя markdown вручную, вполне может набрать "• "
    // по образцу того, что видит в документе — маркер не должен уехать в текст поля
    // (иначе на следующей сборке .docx получится задвоенное "• • пункт").
    const original = protocolToMarkdown(SAMPLE_PROTOCOL);
    expect(original).toContain('- Обновить 1С:БГУ на релиз 2.0.102.79');

    const manuallyEdited = original.replace(
      '- Обновить 1С:БГУ на релиз 2.0.102.79',
      '• Обновить 1С:БГУ на релиз 2.0.102.79',
    );

    const parsed = markdownToProtocol(manuallyEdited);
    const decided = parsed.meetingContent.topics[0].decided;

    expect(decided.startsWith('•')).toBe(false);
    expect(decided).toContain('Обновить 1С:БГУ на релиз 2.0.102.79');
  });
});
