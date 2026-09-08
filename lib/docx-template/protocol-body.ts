/**
 * Protocol → OOXML. Единственное место, где структура протокола превращается
 * в разметку Word. Про zip, файловую систему и HTTP тут не знают.
 */
import {
  cleanProtocolText,
  DECISION_LABEL_SEGMENT_RX,
  formatApprovalOrgLine,
  formatContractBlock,
  isValidOrgDisplayName,
  isValidParticipantRow,
  parseInlineMarkdownBold,
  resolveApprovalForDocument,
  splitDecisionSegments,
} from "@/lib/protocol-markdown-format";
import type { Protocol } from "@/lib/schemas/protocol-schema";
import { cell, paragraph, row, run, table } from "./ooxml";
import {
  IND_AGENDA_HANGING,
  IND_AGENDA_LEFT,
  IND_APPROVAL_NAME_LEFT,
  IND_APPROVAL_NAME_RIGHT,
  IND_SECTION_HANGING,
  IND_SECTION_LEFT,
  IND_TOPIC_HANGING,
  IND_TOPIC_LEFT,
  LINE_115,
  NUM_AGENDA,
  NUM_SECTION,
  NUM_TOPIC,
  SPACING_AFTER_BLOCK,
  SZ_TITLE,
  TBL_APPROVAL,
  TBL_PARTICIPANTS,
  TBL_SUMMARY,
} from "./style";

/** Пустой абзац-разделитель. После таблицы обязателен: иначе Word склеит соседние таблицы. */
function spacer(): string {
  return paragraph("", { spacingLine: LINE_115 });
}

/** Заголовок нумерованного раздела: подчёркнутый текст, номер — из numbering.xml. */
function sectionHeading(title: string, valueXml = ""): string {
  return paragraph(run(title, { underline: true }) + valueXml, {
    numId: NUM_SECTION,
    indentLeft: IND_SECTION_LEFT,
    indentHanging: IND_SECTION_HANGING,
    spacingLine: LINE_115,
  });
}

/** Инлайновый **жирный** из полей протокола → набор <w:r>. */
function inlineRuns(
  text: string,
  options: { bold?: boolean; italic?: boolean } = {},
): string {
  const segments = parseInlineMarkdownBold(cleanProtocolText(text)).filter(
    (s) => s.text.length > 0,
  );
  if (segments.length === 0) return run("", options);
  return segments
    .map((s) =>
      run(s.text, { bold: s.bold || options.bold, italic: options.italic }),
    )
    .join("");
}

export function buildHeaderXml(protocol: Protocol): string {
  const raw = String(protocol.protocolNumber ?? "").trim();
  const number = raw.startsWith("№") ? raw : `№${raw}`;

  const parts: string[] = [
    paragraph(
      run(`ПРОТОКОЛ ${number} ОТ ${protocol.meetingDate}`, {
        bold: true,
        size: SZ_TITLE,
      }),
      {
        align: "center",
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      },
    ),
  ];

  const title = cleanProtocolText(protocol.protocolTitle);
  if (title) {
    parts.push(
      paragraph(run(title, { bold: true, size: SZ_TITLE }), {
        align: "center",
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

  const subject = cleanProtocolText(protocol.contractSubject ?? "");
  if (subject) {
    parts.push(
      paragraph(run("Тема договора: ") + inlineRuns(subject), {
        indentFirstLine: 0,
        spacingAfter: SPACING_AFTER_BLOCK,
      }),
    );
  }

  return parts.join("");
}

export function buildMeetingDateXml(protocol: Protocol): string {
  return sectionHeading("Дата собрания: ", run(protocol.meetingDate));
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
    .join("");

  return sectionHeading("Повестка:") + items;
}

function participantsTable(
  people: Array<{ fullName: string; position: string }>,
): string {
  const [wName, wPos] = TBL_PARTICIPANTS.grid;
  const centered = {
    align: "center",
    indentFirstLine: 0,
    spacingLine: LINE_115,
  } as const;
  const plain = { indentFirstLine: 0, spacingLine: LINE_115 } as const;

  const header = row(
    cell(paragraph(run("ФИО"), centered), { width: wName }) +
      cell(paragraph(run("Должность"), centered), { width: wPos }),
  );

  const body = people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .map((p) =>
      row(
        cell(paragraph(inlineRuns(p.fullName), plain), { width: wName }) +
          cell(paragraph(inlineRuns(p.position), plain), { width: wPos }),
      ),
    )
    .join("");

  return table(header + body, {
    grid: TBL_PARTICIPANTS.grid,
    width: TBL_PARTICIPANTS.width,
    borders: "single",
  });
}

export function buildParticipantsXml(protocol: Protocol): string {
  /** «Заказчик» плюс название организации, если оно осмысленное. */
  const sideLabel = (label: string, org: string) => {
    const name = org?.trim() ?? "";
    const text = isValidOrgDisplayName(name) ? `${label} — ${name}` : label;
    return paragraph(run(text), {
      align: "center",
      indentFirstLine: 0,
      spacingLine: LINE_115,
    });
  };

  const { customer, executor } = protocol.participants;

  return (
    sectionHeading("Участники:") +
    sideLabel("Заказчик", customer.organizationName) +
    participantsTable(customer.people) +
    spacer() +
    sideLabel("Исполнитель", executor.organizationName) +
    participantsTable(executor.people) +
    spacer()
  );
}

/** «Слушали:» / «Обсудили:» / «Решили:». Многострочное значение — по абзацу на строку. */
function labeledBlock(label: string, value: string): string {
  const text = cleanProtocolText(value);
  if (!text) return "";

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return paragraph(run(`${label} `, { bold: true }) + inlineRuns(text), {
      indentFirstLine: 0,
      spacingLine: LINE_115,
    });
  }

  return (
    paragraph(run(label, { bold: true }), {
      indentFirstLine: 0,
      spacingLine: LINE_115,
    }) +
    lines
      .map((line) =>
        paragraph(run("• ") + inlineRuns(line), {
          indentFirstLine: 0,
          indentLeft: IND_TOPIC_LEFT,
          spacingLine: LINE_115,
        }),
      )
      .join("")
  );
}

export function buildMeetingContentXml(protocol: Protocol): string {
  const topics = protocol.meetingContent.topics
    .map((topic) =>
      [
        paragraph(inlineRuns(topic.title, { bold: true }), {
          numId: NUM_TOPIC,
          indentLeft: IND_TOPIC_LEFT,
          indentHanging: IND_TOPIC_HANGING,
          spacingLine: LINE_115,
        }),
        labeledBlock("Слушали:", topic.listened),
        labeledBlock("Обсудили:", topic.discussed),
        labeledBlock("Решили:", topic.decided),
        spacer(),
      ].join(""),
    )
    .join("");

  return sectionHeading("Содержание встречи:") + topics;
}

/** Ячейка решения: основной текст, затем «Срок:» и «Ответственные:» отдельными абзацами. */
function decisionParagraphs(raw: string): string {
  const segments = splitDecisionSegments(raw);
  if (segments.length === 0) return paragraph("", { indentFirstLine: 0 });

  return segments
    .map((segment) => {
      // Общий паттерн меток вынесен в lib/protocol-markdown-format.ts (см. C2) —
      // именно его дублирование по файлам чинили дважды из-за кириллического \b.
      const m = segment.match(DECISION_LABEL_SEGMENT_RX);
      if (m) {
        const rest = m[2].trim();
        return paragraph(
          run(m[1].trim(), { bold: true }) + (rest ? run(` ${rest}`) : ""),
          {
            indentFirstLine: 0,
          },
        );
      }
      return paragraph(inlineRuns(segment), { indentFirstLine: 0 });
    })
    .join("");
}

export function buildSummaryXml(protocol: Protocol): string {
  const rows = protocol.meetingContent.summary;
  if (rows.length === 0) return "";

  const [wQuestion, wDecision] = TBL_SUMMARY.grid;
  const centered = { align: "center", indentFirstLine: 0 } as const;

  const header = row(
    cell(paragraph(run("Обсуждаемые вопросы"), centered), {
      width: wQuestion,
    }) +
      cell(paragraph(run("Принятые решения"), centered), { width: wDecision }),
  );

  const body = rows
    .map((r) =>
      row(
        cell(paragraph(inlineRuns(r.question), { indentFirstLine: 0 }), {
          width: wQuestion,
        }) + cell(decisionParagraphs(r.decision), { width: wDecision }),
      ),
    )
    .join("");

  return (
    paragraph(run("Резюме:", { underline: true }), {
      indentFirstLine: 0,
      spacingLine: LINE_115,
    }) +
    table(header + body, {
      grid: TBL_SUMMARY.grid,
      width: TBL_SUMMARY.width,
      borders: "single",
    }) +
    spacer()
  );
}

export function buildApprovalXml(protocol: Protocol): string {
  const sides = resolveApprovalForDocument(protocol);
  const [wNameLeft, wSignLeft, wNameRight, wSignRight] = TBL_APPROVAL.grid;

  const headSide = (width: number, title: string, organization: string) =>
    cell(
      paragraph(run(title, { bold: true }), { align: "center" }) +
        paragraph(run(formatApprovalOrgLine(organization)), {
          align: "center",
        }),
      { width, gridSpan: 2, borders: "none" },
    );

  const header = row(
    headSide(
      wNameLeft + wSignLeft,
      "Со стороны Заказчика",
      sides.customer.organization,
    ) +
      headSide(
        wNameRight + wSignRight,
        "Со стороны Исполнителя",
        sides.executor.organization,
      ),
  );

  const customerSignatories = sides.customer.signatories;
  const executorSignatories = sides.executor.signatories;
  const rowCount = Math.max(
    customerSignatories.length,
    executorSignatories.length,
    1,
  );

  const body: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const customer = customerSignatories[i]?.trim() ?? "";
    const executor = executorSignatories[i]?.trim() ?? "";

    // Сторона без подписантов всё равно получает одну линию для подписи от руки.
    const customerHasLine = i < Math.max(customerSignatories.length, 1);
    const executorHasLine = i < Math.max(executorSignatories.length, 1);

    body.push(
      row(
        cell(
          paragraph(run(customer), {
            indentLeft: IND_APPROVAL_NAME_LEFT,
            indentFirstLine: 0,
          }),
          {
            width: wNameLeft,
            borders: "none",
          },
        ) +
          cell(paragraph(""), {
            width: wSignLeft,
            borders: customerHasLine ? "bottom" : "none",
          }) +
          cell(
            paragraph(run(executor), {
              indentLeft: IND_APPROVAL_NAME_RIGHT,
              indentFirstLine: 0,
            }),
            { width: wNameRight, borders: "none" },
          ) +
          cell(paragraph(""), {
            width: wSignRight,
            borders: executorHasLine ? "bottom" : "none",
          }),
      ),
    );
  }

  return (
    sectionHeading("Согласовано:") +
    table(header + body.join(""), {
      grid: TBL_APPROVAL.grid,
      width: TBL_APPROVAL.width,
      indent: TBL_APPROVAL.indent,
      borders: "single",
    })
  );
}

export function buildProtocolBodyXml(protocol: Protocol): string {
  return (
    buildHeaderXml(protocol) +
    buildMeetingDateXml(protocol) +
    buildAgendaXml(protocol) +
    buildParticipantsXml(protocol) +
    buildMeetingContentXml(protocol) +
    buildSummaryXml(protocol) +
    buildApprovalXml(protocol) +
    // Абзац после последней таблицы: без него Word считает файл повреждённым.
    paragraph("")
  );
}
