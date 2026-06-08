import { Document, Packer, Paragraph, TextRun, Table, TableCell, TableRow, AlignmentType, WidthType, BorderStyle } from 'docx';
import type { Protocol } from './schemas/protocol-schema';
import {
  cleanProtocolText,
  formatContractBlock,
  parseInlineMarkdownBold,
  resolveApprovalForDocument,
  splitDecisionSegments,
} from './protocol-markdown-format';

/**
 * Renders a labeled block ("Обсудили:", "Решили:") with multiline support.
 * Single-line text: label + text in one paragraph.
 * Multi-line text: label paragraph, then each line as an indented paragraph.
 */
function buildMultilineLabeledBlock(label: string, text: string, spacingAfter: number): Paragraph[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return [
      new Paragraph({
        children: [
          new TextRun({ text: `${label} `, bold: true }),
          new TextRun(text),
        ],
        spacing: { after: spacingAfter },
      }),
    ];
  }
  return [
    new Paragraph({
      children: [new TextRun({ text: label, bold: true })],
      spacing: { after: 60 },
    }),
    ...lines.map((line, idx) =>
      new Paragraph({
        children: [new TextRun(`• ${line}`)],
        indent: { left: 360 },
        spacing: { after: idx === lines.length - 1 ? spacingAfter : 60 },
      }),
    ),
  ];
}

function normalizeDocxOrgName(org: string): string {
  return org.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').replace(/^ООО\s+/, '').trim();
}

function docxRunsFromInlineMarkdown(
  text: string,
  options?: { defaultBold?: boolean; italics?: boolean },
): TextRun[] {
  const segments = parseInlineMarkdownBold(cleanProtocolText(text));
  return segments
    .filter((seg) => seg.text.length > 0)
    .map(
      (seg) =>
        new TextRun({
          text: seg.text,
          bold: seg.bold || options?.defaultBold,
          italics: options?.italics,
        }),
    );
}

function docxParagraphFromInlineMarkdown(
  text: string,
  options?: { defaultBold?: boolean; italics?: boolean; spacingAfter?: number },
): Paragraph {
  const runs = docxRunsFromInlineMarkdown(text, options);
  return new Paragraph({
    children: runs.length ? runs : [new TextRun('')],
    ...(options?.spacingAfter != null ? { spacing: { after: options.spacingAfter } } : {}),
  });
}

function isValidOrgDisplayName(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  if (/^[-–—\s.]+$/.test(s)) return false;
  if (/^(заказчик|исполнитель)$/i.test(s)) return false;
  if (s.length > 100) return false;
  return true;
}

/** Несколько Paragraph в ячейке таблицы — переносы сохраняются в DOCX; метки жирным через TextRun. */
function decisionToDocxParagraphs(raw: string): Paragraph[] {
  const segments = splitDecisionSegments(raw);
  if (segments.length === 0) return [new Paragraph('')];

  return segments.map((segment, index) => {
    const m = segment.match(/^(Срок\s*:|Ответственн\w*\s*:)\s*([\s\S]*)/i);
    if (m) {
      const label = m[1].trim();
      const rest = m[2].trim();
      return new Paragraph({
        children: [
          new TextRun({ text: label, bold: true }),
          ...(rest ? [new TextRun({ text: ` ${rest}` })] : []),
        ],
        spacing: { after: index < segments.length - 1 ? 80 : 0 },
      });
    }
    return new Paragraph({
      children: docxRunsFromInlineMarkdown(segment),
      spacing: { after: index < segments.length - 1 ? 80 : 0 },
    });
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

          // Договор — блок всегда (при отсутствии данных — «не указано в расшифровке»)
          new Paragraph({
            children: [new TextRun(formatContractBlock(protocol))],
            spacing: { after: 100 },
          }),

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
              ? buildMultilineLabeledBlock('Обсудили:', cleanProtocolText(topic.discussed), 100)
              : []),
            ...(topic.decided
              ? buildMultilineLabeledBlock('Решили:', cleanProtocolText(topic.decided), 200)
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

          createApprovalTable(protocol),
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
              new TableCell({ children: [docxParagraphFromInlineMarkdown(p.fullName)] }),
              new TableCell({ children: [docxParagraphFromInlineMarkdown(p.position)] }),
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
              new TableCell({ children: [docxParagraphFromInlineMarkdown(row.question)] }),
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

function formatApprovalOrgLine(org: string): string {
  const n = normalizeDocxOrgName(org);
  if (!n || /^(заказчик|исполнитель)$/i.test(n)) return 'не указано в расшифровке';
  if (/^ООО\s/i.test(org.trim())) return `${org.trim()}:`;
  return `ООО «${n}»:`;
}

function signatoryParagraph(name?: string): Paragraph {
  const n = name?.trim();
  return docxParagraphFromInlineMarkdown(
    n ? `${n} /______________` : '______________________',
    { spacingAfter: 80 },
  );
}

function createApprovalTable(protocol: Protocol): Table {
  const sides = resolveApprovalForDocument(protocol);
  const sigLen = Math.max(
    sides.customer.signatories.length,
    sides.executor.signatories.length,
    1,
  );

  const rows: TableRow[] = [
    new TableRow({
      children: [
        new TableCell({
          children: [
            docxParagraphFromInlineMarkdown('**Со стороны Заказчика**', { defaultBold: true }),
          ],
        }),
        new TableCell({
          children: [
            docxParagraphFromInlineMarkdown('**Со стороны Исполнителя**', { defaultBold: true }),
          ],
        }),
      ],
    }),
    new TableRow({
      children: [
        new TableCell({
          children: [
            docxParagraphFromInlineMarkdown(formatApprovalOrgLine(sides.customer.organization), {
              italics: true,
            }),
          ],
        }),
        new TableCell({
          children: [
            docxParagraphFromInlineMarkdown(formatApprovalOrgLine(sides.executor.organization), {
              italics: true,
            }),
          ],
        }),
      ],
    }),
  ];

  for (let i = 0; i < sigLen; i++) {
    rows.push(
      new TableRow({
        children: [
          new TableCell({ children: [signatoryParagraph(sides.customer.signatories[i])] }),
          new TableCell({ children: [signatoryParagraph(sides.executor.signatories[i])] }),
        ],
      }),
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
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
