/**
 * Protocol → OOXML. Единственное место, где структура протокола превращается
 * в разметку Word. Про zip, файловую систему и HTTP тут не знают.
 */
import {
  cleanProtocolText,
  formatContractBlock,
  isValidOrgDisplayName,
  isValidParticipantRow,
  parseInlineMarkdownBold,
} from '@/lib/protocol-markdown-format';
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { cell, paragraph, row, run, table } from './ooxml';
import {
  IND_AGENDA_HANGING,
  IND_AGENDA_LEFT,
  IND_SECTION_HANGING,
  IND_SECTION_LEFT,
  LINE_115,
  NUM_AGENDA,
  NUM_SECTION,
  SPACING_AFTER_BLOCK,
  SZ_TITLE,
  TBL_PARTICIPANTS,
} from './style';

/** Пустой абзац-разделитель. После таблицы обязателен: иначе Word склеит соседние таблицы. */
function spacer(): string {
  return paragraph('', { spacingLine: LINE_115 });
}

/** Заголовок нумерованного раздела: подчёркнутый текст, номер — из numbering.xml. */
function sectionHeading(title: string, valueXml = ''): string {
  return paragraph(run(title, { underline: true }) + valueXml, {
    numId: NUM_SECTION,
    indentLeft: IND_SECTION_LEFT,
    indentHanging: IND_SECTION_HANGING,
    spacingLine: LINE_115,
  });
}

/** Инлайновый **жирный** из полей протокола → набор <w:r>. */
function inlineRuns(text: string, options: { bold?: boolean; italic?: boolean } = {}): string {
  const segments = parseInlineMarkdownBold(cleanProtocolText(text)).filter((s) => s.text.length > 0);
  if (segments.length === 0) return run('', options);
  return segments
    .map((s) => run(s.text, { bold: s.bold || options.bold, italic: options.italic }))
    .join('');
}

export function buildHeaderXml(protocol: Protocol): string {
  const raw = String(protocol.protocolNumber ?? '').trim();
  const number = raw.startsWith('№') ? raw : `№${raw}`;

  const parts: string[] = [
    paragraph(
      run(`ПРОТОКОЛ ${number} ОТ ${protocol.meetingDate}`, { bold: true, size: SZ_TITLE }),
      { align: 'center', indentFirstLine: 0, spacingAfter: SPACING_AFTER_BLOCK },
    ),
  ];

  const title = cleanProtocolText(protocol.protocolTitle);
  if (title) {
    parts.push(
      paragraph(run(title, { bold: true, size: SZ_TITLE }), {
        align: 'center',
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      }),
    );
  }

  parts.push(
    paragraph(run(formatContractBlock(protocol)), {
      indentFirstLine: 0,
      spacingAfter: SPACING_AFTER_BLOCK,
    }),
  );

  const subject = cleanProtocolText(protocol.contractSubject ?? '');
  if (subject) {
    parts.push(
      paragraph(run('Тема договора: ') + inlineRuns(subject), {
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      }),
    );
  }

  return parts.join('');
}

export function buildMeetingDateXml(protocol: Protocol): string {
  return sectionHeading('Дата собрания: ', run(protocol.meetingDate));
}

export function buildAgendaXml(protocol: Protocol): string {
  const items = protocol.agenda.items
    .map((item) => cleanProtocolText(item))
    .filter(Boolean)
    .map((item) =>
      paragraph(run(item), {
        numId: NUM_AGENDA,
        indentLeft: IND_AGENDA_LEFT,
        indentHanging: IND_AGENDA_HANGING,
        spacingLine: LINE_115,
      }),
    )
    .join('');

  return sectionHeading('Повестка:') + items;
}

function participantsTable(people: Array<{ fullName: string; position: string }>): string {
  const [wName, wPos] = TBL_PARTICIPANTS.grid;
  const centered = { align: 'center', indentFirstLine: 0, spacingLine: LINE_115 } as const;
  const plain = { indentFirstLine: 0, spacingLine: LINE_115 } as const;

  const header = row(
    cell(paragraph(run('ФИО'), centered), { width: wName }) +
      cell(paragraph(run('Должность'), centered), { width: wPos }),
  );

  const body = people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .map((p) =>
      row(
        cell(paragraph(inlineRuns(p.fullName), plain), { width: wName }) +
          cell(paragraph(inlineRuns(p.position), plain), { width: wPos }),
      ),
    )
    .join('');

  return table(header + body, {
    grid: TBL_PARTICIPANTS.grid,
    width: TBL_PARTICIPANTS.width,
    borders: 'single',
  });
}

export function buildParticipantsXml(protocol: Protocol): string {
  /** «Заказчик» плюс название организации, если оно осмысленное. */
  const sideLabel = (label: string, org: string) => {
    const name = org?.trim() ?? '';
    const text = isValidOrgDisplayName(name) ? `${label} — ${name}` : label;
    return paragraph(run(text), { align: 'center', indentFirstLine: 0, spacingLine: LINE_115 });
  };

  const { customer, executor } = protocol.participants;

  return (
    sectionHeading('Участники:') +
    sideLabel('Заказчик', customer.organizationName) +
    participantsTable(customer.people) +
    spacer() +
    sideLabel('Исполнитель', executor.organizationName) +
    participantsTable(executor.people) +
    spacer()
  );
}
