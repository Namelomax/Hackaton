import { Document, Packer, Paragraph, TextRun, Table, TableCell, TableRow, AlignmentType, WidthType, BorderStyle } from 'docx';
import type { Protocol } from './schemas/protocol-schema';
import { cleanProtocolText } from './protocol-markdown-format';

function normalizeDocxOrgName(org: string): string {
  return org.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').replace(/^ООО\s+/, '').trim();
}

function isValidOrgDisplayName(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  if (/^[-–—\s.]+$/.test(s)) return false;
  if (/^(заказчик|исполнитель)$/i.test(s)) return false;
  if (s.length > 100) return false;
  return true;
}

/** Splits a decision string at «Срок:» / «Ответственный:» markers, returning multiple Paragraphs with bold labels. */
function decisionToDocxParagraphs(raw: string): Paragraph[] {
  let s = cleanProtocolText(raw);
  s = s.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!s) return [new Paragraph('')];

  // Split at Срок: and Ответственный: markers (lookahead keeps the keyword in the segment)
  const segments = s.split(/(?=\s*(?:Срок\s*:|Ответственн\w*\s*:))/i).map((p) => p.trim()).filter(Boolean);

  if (segments.length <= 1) {
    return [new Paragraph({ text: s })];
  }

  return segments.map((segment) => {
    const m = segment.match(/^(Срок\s*:|Ответственн\w*\s*:)\s*(.*)/i);
    if (m) {
      return new Paragraph({
        children: [
          new TextRun({ text: m[1], bold: true }),
          ...(m[2].trim() ? [new TextRun({ text: ` ${m[2].trim()}` })] : []),
        ],
      });
    }
    return new Paragraph({ text: segment });
  });
}

export async function generateProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const normalizedNumber = String(protocol.protocolNumber || '').trim().startsWith('№')
    ? String(protocol.protocolNumber).trim()
    : `№${String(protocol.protocolNumber || '').trim()}`;

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Заголовок: ПРОТОКОЛ № X ОТ DD.MM.YYYY
          new Paragraph({
            children: [new TextRun({ text: `ПРОТОКОЛ ${normalizedNumber} ОТ ${protocol.meetingDate}`, bold: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          }),

          // Название протокола
          ...(protocol.protocolTitle
            ? [
                new Paragraph({
                  children: [new TextRun({ text: cleanProtocolText(protocol.protocolTitle), bold: true })],
                  alignment: AlignmentType.CENTER,
                  spacing: { after: 300 },
                }),
              ]
            : []),

          // Договор
          ...(protocol.contractNumber
            ? [
                new Paragraph({
                  children: [
                    new TextRun(`Договор №${cleanProtocolText(protocol.contractNumber)}`),
                    ...(protocol.contractDate ? [new TextRun(` от ${cleanProtocolText(protocol.contractDate)} г.`)] : []),
                  ],
                  spacing: { after: 100 },
                }),
              ]
            : []),

          // Тема договора
          ...(protocol.contractSubject
            ? [
                new Paragraph({
                  children: [
                    new TextRun('Тема договора: '),
                    new TextRun({ text: cleanProtocolText(protocol.contractSubject), italics: true }),
                  ],
                  spacing: { after: 300 },
                }),
              ]
            : []),

          // 1. Дата собрания
          new Paragraph({
            children: [
              new TextRun({ text: '1.\tДата собрания: ', bold: true }),
              new TextRun(protocol.meetingDate),
            ],
            spacing: { after: 200 },
          }),

          // 2. Повестка
          new Paragraph({
            children: [new TextRun({ text: '2.\tПовестка:', bold: true })],
            spacing: { before: 200, after: 100 },
          }),
          ...protocol.agenda.items.map(
            (item, i) =>
              new Paragraph({
                text: `${i + 1})\t${item}`,
                spacing: { after: 100 },
                indent: { left: 360 },
              }),
          ),

          // 3. Участники
          new Paragraph({
            children: [new TextRun({ text: '3.\tУчастники:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),

          new Paragraph({
            children: [
              new TextRun({
                text: `Заказчик${isValidOrgDisplayName(protocol.participants.customer.organizationName?.trim() ?? '') ? ` — ${protocol.participants.customer.organizationName.trim()}` : ''}`,
                bold: true,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
          }),
          createParticipantsTable(protocol.participants.customer.people),

          new Paragraph({
            children: [
              new TextRun({
                text: `Исполнитель${isValidOrgDisplayName(protocol.participants.executor.organizationName?.trim() ?? '') ? ` — ${protocol.participants.executor.organizationName.trim()}` : ''}`,
                bold: true,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { before: 300, after: 100 },
          }),
          createParticipantsTable(protocol.participants.executor.people),

          // 4. Содержание встречи
          new Paragraph({
            children: [new TextRun({ text: '4.\tСодержание встречи:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),

          ...protocol.meetingContent.topics.flatMap((topic, i) => [
            new Paragraph({
              children: [new TextRun({ text: `${i + 1}) ${cleanProtocolText(topic.title)}`, bold: true })],
              spacing: { before: 200, after: 100 },
            }),
            ...(topic.listened
              ? [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'Слушали: ', bold: true }),
                      new TextRun(cleanProtocolText(topic.listened)),
                    ],
                    spacing: { after: 100 },
                  }),
                ]
              : []),
            ...(topic.discussed
              ? [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'Обсудили: ', bold: true }),
                      new TextRun(cleanProtocolText(topic.discussed)),
                    ],
                    spacing: { after: 100 },
                  }),
                ]
              : []),
            ...(topic.decided
              ? [
                  new Paragraph({
                    children: [
                      new TextRun({ text: 'Решили: ', bold: true }),
                      new TextRun(cleanProtocolText(topic.decided)),
                    ],
                    spacing: { after: 200 },
                  }),
                ]
              : []),
          ]),

          // Резюме
          ...(protocol.meetingContent.summary.length > 0
            ? [
                new Paragraph({
                  children: [new TextRun({ text: 'Резюме:', bold: true })],
                  spacing: { before: 300, after: 100 },
                }),
                createSummaryTable(protocol.meetingContent.summary),
              ]
            : []),

          // 5. Согласовано
          new Paragraph({
            children: [new TextRun({ text: '5.\tСогласовано:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),

          createApprovalTable(protocol.approval),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

function createParticipantsTable(participants: Array<{ fullName: string; position: string }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'ФИО', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Должность', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
        ],
      }),
      ...participants.map(
        (p) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(p.fullName)] }),
              new TableCell({ children: [new Paragraph(p.position)] }),
            ],
          }),
      ),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
    },
  });
}

function createSummaryTable(summary: Array<{ question: string; decision: string }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Обсуждаемые вопросы', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Принятые решения', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
        ],
      }),
      ...summary.map(
        (row) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(cleanProtocolText(row.question))] }),
              new TableCell({ children: decisionToDocxParagraphs(row.decision) }),
            ],
          }),
      ),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
    },
  });
}

function createApprovalTable(approval: Protocol['approval']): Table {
  const makeSignatoryParagraphs = (signatories: string[]) =>
    signatories.length > 0
      ? signatories.map((name) => new Paragraph({ text: `${name} /______________` }))
      : [new Paragraph({ text: '______________________' })];

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Со стороны Заказчика', bold: true })] }),
              ...(approval.customer.organization && !/^заказчик$/i.test(approval.customer.organization)
                ? [new Paragraph({ children: [new TextRun({ text: `ООО «${normalizeDocxOrgName(approval.customer.organization)}»:`, italics: true })] })]
                : []),
              new Paragraph({ text: '' }),
              ...makeSignatoryParagraphs(approval.customer.signatories),
            ],
            width: { size: 50, type: WidthType.PERCENTAGE },
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Со стороны Исполнителя', bold: true })] }),
              ...(approval.executor.organization && !/^исполнитель$/i.test(approval.executor.organization)
                ? [new Paragraph({ children: [new TextRun({ text: `ООО «${normalizeDocxOrgName(approval.executor.organization)}»:`, italics: true })] })]
                : []),
              new Paragraph({ text: '' }),
              ...makeSignatoryParagraphs(approval.executor.signatories),
            ],
            width: { size: 50, type: WidthType.PERCENTAGE },
          }),
        ],
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
      insideVertical: { style: BorderStyle.SINGLE, size: 1 },
    },
  });
}
