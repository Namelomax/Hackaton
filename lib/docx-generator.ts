import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  AlignmentType,
  WidthType,
  BorderStyle,
} from 'docx';
import type { Protocol } from './schemas/protocol-schema';
import { cleanProtocolText } from './protocol-markdown-format';

const TAB = '\t';

function labelRun(label: string): TextRun {
  return new TextRun({ text: label, bold: true });
}

function bodyParagraph(text: string, options?: { indent?: number; spacingAfter?: number }): Paragraph {
  return new Paragraph({
    children: [new TextRun(cleanProtocolText(text))],
    spacing: { after: options?.spacingAfter ?? 120 },
    ...(options?.indent ? { indent: { left: options.indent } } : {}),
  });
}

function labeledParagraph(label: string, text: string): Paragraph {
  return new Paragraph({
    children: [labelRun(label), new TextRun(cleanProtocolText(text))],
    spacing: { after: 120 },
  });
}

export async function generateProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const numRaw = String(protocol.protocolNumber || '').trim().replace(/^№\s*/i, '');
  const num = numRaw || '—';
  const protoDate = protocol.protocolDate.trim() || '—';

  const headerChildren: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: `ПРОТОКОЛ №  ${num}  ОТ  ${protoDate}`, bold: false })],
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 },
    }),
    bodyParagraph(protocol.protocolTitle || '—'),
  ];

  const contractNum = protocol.contractNumber.trim();
  const contractDate = protocol.contractDate.trim();
  const contractMissing =
    !contractNum || /не\s+указан/i.test(contractNum) || /не\s+указан/i.test(contractDate);
  if (!contractMissing) {
    headerChildren.push(
      bodyParagraph(
        `Договор №${contractNum.replace(/^№/, '')}${contractDate ? ` от ${contractDate}` : ''}`,
      ),
    );
  }
  if (protocol.contractTopic.trim()) {
    headerChildren.push(bodyParagraph(`Тема договора: ${protocol.contractTopic}`));
  }

  const meetingBlocks = protocol.meetingQuestions.flatMap((q, i) => {
    const paras: Paragraph[] = [
      new Paragraph({
        children: [
          new TextRun({ text: `${i + 1})${TAB}`, bold: false }),
          new TextRun(cleanProtocolText(q.question)),
        ],
        spacing: { after: 80 },
      }),
    ];
    if (q.listened.trim()) paras.push(labeledParagraph('Слушали: ', q.listened));
    if (q.discussed.trim()) paras.push(labeledParagraph('Обсудили: ', q.discussed));
    if (q.decided.trim()) paras.push(labeledParagraph('Решили: ', q.decided));
    return paras;
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          ...headerChildren,

          new Paragraph({
            children: [
              labelRun('1.'),
              new TextRun({ text: TAB }),
              labelRun('Дата собрания: '),
              new TextRun(protocol.assemblyDate || protoDate),
            ],
            spacing: { after: 200 },
          }),

          new Paragraph({
            children: [labelRun('2.'), new TextRun({ text: TAB }), labelRun('Повестка:')],
            spacing: { after: 100 },
          }),
          ...protocol.agendaItems.map(
            (item, i) =>
              new Paragraph({
                children: [
                  new TextRun({ text: `${i + 1})${TAB}` }),
                  new TextRun(cleanProtocolText(item)),
                ],
                spacing: { after: 80 },
                indent: { left: 360 },
              }),
          ),

          new Paragraph({
            children: [labelRun('3.'), new TextRun({ text: TAB }), labelRun('Участники:')],
            spacing: { before: 200, after: 100 },
          }),
          new Paragraph({ text: 'Заказчик', spacing: { after: 80 } }),
          createParticipantsTable(protocol.participants.customer.people),
          new Paragraph({ text: 'Исполнитель', spacing: { before: 200, after: 80 } }),
          createParticipantsTable(protocol.participants.executor.people),

          new Paragraph({
            children: [labelRun('4.'), new TextRun({ text: TAB }), labelRun('Содержание встречи:')],
            spacing: { before: 400, after: 200 },
          }),
          ...meetingBlocks,

          ...(protocol.resume.length
            ? [
                new Paragraph({
                  children: [labelRun('Резюме:')],
                  spacing: { before: 200, after: 100 },
                }),
                createResumeTable(protocol.resume),
              ]
            : []),

          new Paragraph({
            children: [labelRun('5.'), new TextRun({ text: TAB }), labelRun('Согласовано:')],
            spacing: { before: 400, after: 200 },
          }),
          createSignatureTable(protocol.approval),
        ],
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

function createParticipantsTable(participants: Array<{ fullName: string; position: string }>): Table {
  const rows = participants.length
    ? participants
    : [{ fullName: '', position: '' }];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [labelRun('ФИО')] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [labelRun('Должность')] })],
            shading: { fill: 'D9D9D9' },
          }),
        ],
      }),
      ...rows.map(
        (p) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph(p.fullName)] }),
              new TableCell({ children: [new Paragraph(p.position)] }),
            ],
          }),
      ),
    ],
    borders: tableBorders(),
  });
}

function createResumeTable(rows: Protocol['resume']): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [labelRun('Обсуждаемые вопросы')] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [labelRun('Принятые решения')] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [labelRun('Срок')] })],
            shading: { fill: 'D9D9D9' },
          }),
          new TableCell({
            children: [new Paragraph({ children: [labelRun('Ответственный')] })],
            shading: { fill: 'D9D9D9' },
          }),
        ],
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph(cleanProtocolText(row.discussedQuestion))],
              }),
              new TableCell({
                children: [new Paragraph(cleanProtocolText(row.decision))],
              }),
              new TableCell({
                children: [new Paragraph(cleanProtocolText(row.deadline ?? '—'))],
              }),
              new TableCell({
                children: [new Paragraph(cleanProtocolText(row.responsible ?? '—'))],
              }),
            ],
          }),
      ),
    ],
    borders: tableBorders(),
  });
}

function createSignatureTable(approval: Protocol['approval']): Table {
  const maxSigs = Math.max(
    approval.customer.signatories.length,
    approval.executor.signatories.length,
    1,
  );
  const rows: TableRow[] = [
    new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({ children: [labelRun('Со стороны Заказчика')] }),
            new Paragraph(`${approval.customer.organizationName}:`),
          ],
        }),
        new TableCell({
          children: [
            new Paragraph({ children: [labelRun('Со стороны Исполнителя')] }),
            new Paragraph(`${approval.executor.organizationName}:`),
          ],
        }),
      ],
    }),
  ];
  for (let i = 0; i < maxSigs; i++) {
    rows.push(
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph(approval.customer.signatories[i]?.trim() || '________________'),
            ],
          }),
          new TableCell({
            children: [
              new Paragraph(approval.executor.signatories[i]?.trim() || '________________'),
            ],
          }),
        ],
      }),
    );
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows, borders: tableBorders() });
}

function tableBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1 },
    bottom: { style: BorderStyle.SINGLE, size: 1 },
    left: { style: BorderStyle.SINGLE, size: 1 },
    right: { style: BorderStyle.SINGLE, size: 1 },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
    insideVertical: { style: BorderStyle.SINGLE, size: 1 },
  };
}
