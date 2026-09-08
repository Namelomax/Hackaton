import {
  buildApprovalXml,
  buildMeetingContentXml,
  buildProtocolBodyXml,
  buildSummaryXml,
} from '../protocol-body';
import { NUM_TOPIC, TBL_APPROVAL, TBL_SUMMARY } from '../style';
import { SAMPLE_PROTOCOL } from './fixtures';

describe('buildMeetingContentXml', () => {
  it('нумерует вопросы отдельным списком', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    expect(xml.match(new RegExp(`<w:numId w:val="${NUM_TOPIC}"/>`, 'g'))).toHaveLength(2);
    expect(xml).toContain('Принятие решения о версии обновления');
    expect(xml).toContain('Доступ к тестовому контуру');
  });

  it('делает метки Слушали/Обсудили/Решили жирными', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    for (const label of ['Слушали:', 'Обсудили:', 'Решили:']) {
      expect(xml).toContain(`<w:b/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${label}`);
    }
  });

  it('многострочное решение разбивает на абзацы с маркерами', () => {
    const xml = buildMeetingContentXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Срок: 09.04.2025');
    expect(xml).toContain('Ответственные: Петров П.П.');
    expect(xml).toContain('<w:t xml:space="preserve">• </w:t>');
  });

  it('пропускает пустые блоки', () => {
    const xml = buildMeetingContentXml({
      ...SAMPLE_PROTOCOL,
      meetingContent: {
        summary: [],
        topics: [{ title: 'Вопрос', listened: '', discussed: '', decided: '' }],
      },
    });

    expect(xml).not.toContain('Слушали');
    expect(xml).not.toContain('Обсудили');
  });
});

describe('buildSummaryXml', () => {
  it('строит таблицу шаблонной ширины и подчёркивает заголовок', () => {
    const xml = buildSummaryXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(`<w:tblW w:w="${TBL_SUMMARY.width}" w:type="dxa"/>`);
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('Резюме:');
    expect(xml).toContain('Обсуждаемые вопросы');
    expect(xml).toContain('Принятые решения');
  });

  it('не нумерует Резюме — в шаблоне это не раздел', () => {
    expect(buildSummaryXml(SAMPLE_PROTOCOL)).not.toContain('<w:numPr>');
  });

  it('метки Срок и Ответственные — отдельными жирными абзацами', () => {
    const xml = buildSummaryXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('<w:t xml:space="preserve">Срок:</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">Ответственные:</w:t>');
  });

  it('на пустом резюме не выводит ничего', () => {
    const xml = buildSummaryXml({
      ...SAMPLE_PROTOCOL,
      meetingContent: { ...SAMPLE_PROTOCOL.meetingContent, summary: [] },
    });
    expect(xml).toBe('');
  });
});

describe('buildApprovalXml', () => {
  it('строит таблицу из четырёх колонок с отступом', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(
      TBL_APPROVAL.grid.map((w) => `<w:gridCol w:w="${w}"/>`).join(''),
    );
    expect(xml).toContain(`<w:tblInd w:w="${TBL_APPROVAL.indent}" w:type="dxa"/>`);
  });

  it('шапку разносит на две ячейки по две колонки', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Со стороны Заказчика');
    expect(xml).toContain('Со стороны Исполнителя');
    expect(xml.match(/<w:gridSpan w:val="2"\/>/g)).toHaveLength(2);
  });

  it('даёт по строке на подписанта — их столько, сколько у самой длинной стороны', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain('Иванов И.И.');
    expect(xml).toContain('Петров П.П.');
    expect(xml).toContain('Сидоров С.С.');
    // Шапка + две строки подписантов.
    expect(xml.match(/<w:tr>/g)).toHaveLength(3);
  });

  it('линия подписи — нижняя граница ячейки, а не подчёркнутый текст', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);

    expect(xml).toContain(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
    expect(xml).not.toContain('/______________');
  });

  it('не рисует лишнюю линию там, где у стороны подписанта нет', () => {
    const xml = buildApprovalXml(SAMPLE_PROTOCOL);
    const rows = xml.split('<w:tr>').slice(1);
    const lastRow = rows[rows.length - 1];

    // Во второй строке подписант есть только у исполнителя: одна линия, а не две.
    const lines = lastRow.match(
      /<w:tcBorders><w:top w:val="nil"\/><w:left w:val="nil"\/><w:right w:val="nil"\/><\/w:tcBorders>/g,
    );
    expect(lines).toHaveLength(1);
  });

  it('оформляет название организации так же, как markdown-версия протокола', () => {
    const xml = buildApprovalXml({
      ...SAMPLE_PROTOCOL,
      approval: {
        customer: { organization: 'Ромашка', signatories: ['Иванов И.И.'] },
        executor: { organization: 'ООО «Форус»', signatories: ['Петров П.П.'] },
      },
    });

    // formatApprovalOrgLine добавляет двоеточие и не дописывает ООО к голому имени.
    expect(xml).toContain('Ромашка:');
    expect(xml).toContain('ООО «Форус»:');
  });

  it('пишет заглушку, когда организация не распознана', () => {
    const xml = buildApprovalXml({
      ...SAMPLE_PROTOCOL,
      participants: {
        customer: { organizationName: '', people: [] },
        executor: { organizationName: '', people: [] },
      },
      approval: {
        customer: { organization: '', signatories: [] },
        executor: { organization: '', signatories: [] },
      },
    });

    expect(xml).toContain('не указано в расшифровке');
  });
});

describe('снимок вёрстки', () => {
  it('document.xml тела протокола не меняется незаметно', () => {
    expect(buildProtocolBodyXml(SAMPLE_PROTOCOL)).toMatchSnapshot();
  });
});

describe('buildProtocolBodyXml', () => {
  it('собирает все разделы по порядку', () => {
    const xml = buildProtocolBodyXml(SAMPLE_PROTOCOL);
    const order = [
      'ПРОТОКОЛ №7',
      'Дата собрания:',
      'Повестка:',
      'Участники:',
      'Содержание встречи:',
      'Резюме:',
      'Согласовано:',
    ];

    let previous = -1;
    for (const marker of order) {
      const at = xml.indexOf(marker);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  });

  it('заканчивается абзацем — иначе Word ломается на таблице перед sectPr', () => {
    expect(buildProtocolBodyXml(SAMPLE_PROTOCOL).endsWith('<w:p></w:p>')).toBe(true);
  });

  it('не оставляет незакрытых тегов', () => {
    const xml = buildProtocolBodyXml(SAMPLE_PROTOCOL);

    expect(xml.match(/<w:tbl>/g)?.length).toBe(xml.match(/<\/w:tbl>/g)?.length);
    expect(xml.match(/<w:tc>/g)?.length).toBe(xml.match(/<\/w:tc>/g)?.length);
    expect(xml.match(/<w:p>/g)?.length).toBe(xml.match(/<\/w:p>/g)?.length);
  });
});
