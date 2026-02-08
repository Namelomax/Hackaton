import { Document, Packer, Paragraph, TextRun, Table, TableCell, TableRow, AlignmentType, WidthType, BorderStyle } from 'docx';
import type { Protocol } from './schemas/protocol-schema';

/**
 * Генерирует .docx документ из структурированного протокола
 */
export async function generateProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Заголовок документа
          new Paragraph({
            text: `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${protocol.protocolNumber}`,
            heading: 'Heading1',
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),

          // 1. Дата встречи
          new Paragraph({
            children: [
              new TextRun({ text: '1.\tДата встречи: ', bold: true }),
              new TextRun(protocol.meetingDate),
            ],
            spacing: { after: 200 },
          }),

          // 2. Повестка
          new Paragraph({
            children: [
              new TextRun({ text: '2.\tПовестка: ', bold: true }),
              new TextRun(protocol.agenda.title),
            ],
            spacing: { after: 100 },
          }),
          ...protocol.agenda.items.map(
            (item) =>
              new Paragraph({
                text: `•\t${item}`,
                spacing: { after: 100 },
                indent: { left: 720 },
              })
          ),

          // 3. Участники
          new Paragraph({
            children: [new TextRun({ text: '3.\tУчастники:', bold: true })],
            spacing: { before: 200, after: 200 },
          }),

          new Paragraph({
            text: `Со стороны Заказчика ${protocol.participants.customer.organizationName}:`,
            spacing: { after: 100 },
          }),

          createParticipantsTable(protocol.participants.customer.people),

          new Paragraph({
            text: `Со стороны Исполнителя ${protocol.participants.executor.organizationName}:`,
            spacing: { before: 200, after: 100 },
          }),

          createParticipantsTable(protocol.participants.executor.people),

          // 4. Термины и определения
          new Paragraph({
            children: [new TextRun({ text: '4.\tТермины и определения:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...protocol.termsAndDefinitions.map(
            (item) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `•\t${item.term}`, bold: true }),
                  new TextRun(` – ${item.definition}`),
                ],
                spacing: { after: 100 },
                indent: { left: 360 },
              })
          ),

          // 5. Сокращения и обозначения
          new Paragraph({
            children: [new TextRun({ text: '5.\tСокращения и обозначения:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...protocol.abbreviations.map(
            (item) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `•\t${item.abbreviation}`, bold: true }),
                  new TextRun(` – ${item.fullForm}`),
                ],
                spacing: { after: 100 },
                indent: { left: 360 },
              })
          ),

          // 6. Содержание встречи
          new Paragraph({
            children: [new TextRun({ text: '6.\tСодержание встречи:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...(protocol.meetingContent.introduction
            ? [
                new Paragraph({
                  text: protocol.meetingContent.introduction,
                  spacing: { after: 200 },
                }),
              ]
            : []),
          ...protocol.meetingContent.topics.flatMap((topic) => [
            new Paragraph({
              children: [new TextRun({ text: topic.title, bold: true })],
              spacing: { before: 200, after: 100 },
            }),
            new Paragraph({
              text: topic.content,
              spacing: { after: 200 },
            }),
            ...(topic.subtopics || []).flatMap((sub) => [
              ...(sub.title
                ? [
                    new Paragraph({
                      children: [new TextRun({ text: sub.title, bold: true })],
                      spacing: { before: 100, after: 100 },
                      indent: { left: 360 },
                    }),
                  ]
                : []),
              new Paragraph({
                text: sub.content,
                spacing: { after: 100 },
                indent: { left: 360 },
              }),
            ]),
          ]),
          ...(protocol.meetingContent.migrationFeatures
            ? [
                new Paragraph({
                  children: [new TextRun({ text: 'Особенности миграции по вкладкам МТР.', bold: true })],
                  spacing: { before: 200, after: 100 },
                }),
                createMigrationFeaturesTable(protocol.meetingContent.migrationFeatures),
              ]
            : []),

          // 7. Вопросы
          new Paragraph({
            children: [new TextRun({ text: '7.\tВопросы:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...protocol.questionsAndAnswers.flatMap((qa, index) => [
            new Paragraph({
              children: [
                new TextRun({ text: `${index + 1}.\t`, bold: true }),
                new TextRun(qa.question),
              ],
              spacing: { after: 100 },
            }),
          ]),
          new Paragraph({
            children: [new TextRun({ text: 'Ответы:', bold: true })],
            spacing: { before: 200, after: 100 },
          }),
          ...protocol.questionsAndAnswers.flatMap((qa, index) => [
            new Paragraph({
              children: [
                new TextRun({ text: `${index + 1}.\t`, bold: true }),
                new TextRun(qa.answer),
              ],
              spacing: { after: 100 },
            }),
          ]),

          // 8. Решения
          new Paragraph({
            children: [new TextRun({ text: '8.\tРешения:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...protocol.decisions.map(
            (decision, index) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `${index + 1}.\t` }),
                  new TextRun(decision.decision),
                  new TextRun({ text: '\nОтветственный: ', bold: true }),
                  new TextRun(decision.responsible),
                ],
                spacing: { after: 200 },
              })
          ),

          // 9. Открытые вопросы
          new Paragraph({
            children: [new TextRun({ text: '9.\tОткрытые вопросы:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),
          ...protocol.openQuestions.map(
            (question, index) =>
              new Paragraph({
                text: `${index + 1}.\t${question}`,
                spacing: { after: 100 },
              })
          ),

          // 10. Согласовано
          new Paragraph({
            children: [new TextRun({ text: '10.\tСогласовано:', bold: true })],
            spacing: { before: 400, after: 200 },
          }),

          new Paragraph({
            text: '',
            spacing: { after: 200 },
          }),

          createSignatureTable(protocol.approval),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

/**
 * Создает таблицу участников
 */
function createParticipantsTable(participants: Array<{ fullName: string; position: string }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Заголовок
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
      // Строки данных
      ...participants.map(
        (p) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(p.fullName)] }),
              new TableCell({ children: [new Paragraph(p.position)] }),
            ],
          })
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

/**
 * Создает таблицу особенностей миграции
 */
function createMigrationFeaturesTable(features: Array<{ tab: string; features: string }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Заголовок
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Вкладка', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Особенности', bold: true })] })],
            shading: { fill: 'D9D9D9' },
          }),
        ],
      }),
      // Строки данных
      ...features.map(
        (f) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(f.tab)] }),
              new TableCell({ children: [new Paragraph(f.features)] }),
            ],
          })
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

/**
 * Создает таблицу для подписей
 */
function createSignatureTable(approval: {
  executorSignature: { organization: string; representative: string };
  customerSignature: { organization: string; representative: string };
}): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Со стороны Исполнителя:', bold: true })] }),
              new Paragraph({ text: approval.executorSignature.organization }),
              new Paragraph({ text: '' }),
              new Paragraph({ text: `${approval.executorSignature.representative} /______________` }),
            ],
            width: { size: 50, type: WidthType.PERCENTAGE },
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Со стороны Заказчика:', bold: true })] }),
              new Paragraph({ text: approval.customerSignature.organization }),
              new Paragraph({ text: '' }),
              new Paragraph({ text: `${approval.customerSignature.representative} /______________` }),
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
