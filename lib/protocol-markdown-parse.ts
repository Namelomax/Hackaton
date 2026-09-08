/**
 * Обратный разбор markdown-протокола в Protocol.
 *
 * Нужен ровно для одного сценария: пользователь отредактировал текст в правой
 * панели руками, и DOCX надо пересобрать из правленого текста. Формат входа
 * фиксирован — его порождает protocolToMarkdown. Детерминированно, без LLM.
 */
import {
  fixProtocolSectionHeadingsInMarkdown,
  isMarkdownTableSeparatorRow,
  isValidParticipantRow,
} from "./protocol-markdown-format";
import {
  coerceProtocolPartial,
  type Protocol,
} from "./schemas/protocol-schema";

const SECTION_RX = /^##\s*(\d{1,2})\.\s*(.+?)\s*$/;

interface Section {
  title: string;
  body: string[];
}

/** Снимает пометки, которые markUnresolvedInMarkdown добавляет только для показа в панели. */
function stripUnresolvedMarkers(text: string): string {
  return String(text ?? "")
    .replace(/\s*—\s*(?:⚠️\s*)?требует уточнения/gi, "")
    .replace(/⚠️\s*/g, "");
}

function splitSections(lines: string[]): {
  preamble: string[];
  sections: Section[];
} {
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    const m = line.match(SECTION_RX);
    if (m) {
      current = { title: m[2], body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }

  return { preamble, sections };
}

function findSection(sections: Section[], rx: RegExp): Section | undefined {
  return sections.find((s) => rx.test(s.title));
}

/**
 * Разэкранирует ячейку markdown-таблицы: \| → |, <br> → перенос строки.
 * Симметрична escapeMarkdownTableCell в lib/protocol-markdown-format.ts.
 * Осторожно: summaryCellToPlain ниже по цепочке тоже разворачивает <br> —
 * после этой функции в ячейке уже обычный \n, поэтому повторный проход
 * там просто не находит совпадений (двойного преобразования нет).
 */
function unescapeMarkdownTableCell(text: string): string {
  return text.replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n");
}

/** Читает подряд идущие строки markdown-таблицы, пропуская строку-разделитель. */
function parseTableRows(
  lines: string[],
  start: number,
): { rows: string[][]; next: number } {
  const rows: string[][] = [];
  let i = start;

  while (i < lines.length && lines[i].trim().startsWith("|")) {
    const cells = lines[i]
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      // Не резать по экранированному \| — это часть текста ячейки, а не граница колонки.
      .split(/(?<!\\)\|/)
      .map((c) => unescapeMarkdownTableCell(c.trim()));
    if (!isMarkdownTableSeparatorRow(cells)) rows.push(cells);
    i++;
  }

  return { rows, next: i };
}

function firstTableIndex(lines: string[]): number {
  return lines.findIndex((l) => l.trim().startsWith("|"));
}

function parseContract(text: string): {
  contractNumber?: string;
  contractDate?: string;
} {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    // \b после кириллицы в JS не работает: \w покрывает только ASCII, поэтому
    // граница «буква + пробел» не распознаётся как word boundary. Проверяем
    // явно, что после «Договор» идёт «:» или пробел (или конец строки).
    .find((l) => /^Договор(?=[:\s]|$)/i.test(l));

  if (!line || /не\s+указан/i.test(line)) return {};

  const number = line.match(/№\s*(\S+)/);
  // Аналогично: \bот\s+ не сработает после пробела перед кириллицей — требуем
  // пробел явно вместо word boundary.
  const date = line.match(/\sот\s+(.+?)(?:\s*г\.)?$/i);

  return {
    contractNumber: number ? number[1].trim() : undefined,
    contractDate: date ? date[1].trim() : undefined,
  };
}

function parsePreamble(preamble: string[]) {
  const text = preamble.join("\n");

  // [ \t]* перед группой даты, а не \s*: \s захватывает и перенос строки, и при
  // пустой дате ("ОТ \n\n**Заголовок**") группа "утекала" на следующую строку —
  // meetingDate становился "**Заголовок**" (см. B1 в отчёте).
  const head = text.match(/ПРОТОКОЛ\s*(\S+)\s*ОТ[ \t]*([^\n]*)/i);
  const protocolNumber = head ? head[1].trim() : "";
  const meetingDate = head ? head[2].trim() : "";

  const titleLine = preamble.find((l) => /^\*\*.+\*\*$/.test(l.trim()));
  const protocolTitle = titleLine
    ? titleLine
        .trim()
        .replace(/^\*\*|\*\*$/g, "")
        .trim()
    : "";

  const subjectLine = preamble
    .map((l) => l.trim())
    .find((l) => /^Тема договора:/i.test(l));
  const contractSubject = subjectLine
    ? subjectLine.replace(/^Тема договора:\s*/i, "").trim()
    : undefined;

  return {
    protocolNumber,
    meetingDate,
    protocolTitle,
    contractSubject,
    ...parseContract(text),
  };
}

function parseAgenda(body: string[]): string[] {
  return (
    body
      .map((l) => l.trim())
      .filter((l) => /^\d+[).]\s+/.test(l))
      // Точку с запятой в конце ставит форматтер, в исходных данных её нет.
      .map((l) =>
        l
          .replace(/^\d+[).]\s+/, "")
          .replace(/;$/, "")
          .trim(),
      )
      .filter(Boolean)
  );
}

function emptySide() {
  return {
    organizationName: "",
    people: [] as Array<{ fullName: string; position: string }>,
  };
}

function parseParticipants(body: string[]) {
  const sides = { customer: emptySide(), executor: emptySide() };
  let side: "customer" | "executor" | null = null;

  for (let i = 0; i < body.length; i++) {
    const line = body[i].trim();

    const head = line.match(
      /^\*\*(Заказчик|Исполнитель)(?:\s*[—–-]\s*(.+?))?\*\*$/,
    );
    if (head) {
      side = head[1] === "Заказчик" ? "customer" : "executor";
      sides[side].organizationName = (head[2] ?? "").trim();
      continue;
    }

    if (side && line.startsWith("|")) {
      const { rows, next } = parseTableRows(body, i);
      sides[side].people = rows
        .map((cells) => ({
          fullName: cells[0] ?? "",
          position: cells[1] ?? "",
        }))
        .filter((p) => isValidParticipantRow(p.fullName, p.position));
      i = next - 1;
      side = null;
    }
  }

  return sides;
}

/** Ячейка резюме: <br> и жирный — это разметка форматтера, в поле их быть не должно. */
function summaryCellToPlain(cellText: string): string {
  return cellText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\*\*/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

function parseContent(body: string[]) {
  const topics: Protocol["meetingContent"]["topics"] = [];
  const summary: Protocol["meetingContent"]["summary"] = [];

  let topic: Protocol["meetingContent"]["topics"][number] | null = null;
  let label: "listened" | "discussed" | "decided" | null = null;

  for (let i = 0; i < body.length; i++) {
    const trimmed = body[i].trim();

    const topicHead = trimmed.match(/^\*\*\s*\d+\)\s*(.+?)\s*\*\*$/);
    if (topicHead) {
      topic = { title: topicHead[1], listened: "", discussed: "", decided: "" };
      topics.push(topic);
      label = null;
      continue;
    }

    if (/^\*\*Резюме:\*\*$/i.test(trimmed)) {
      const from = firstTableIndex(body.slice(i + 1));
      if (from >= 0) {
        const { rows, next } = parseTableRows(body, i + 1 + from);
        for (const cells of rows) {
          const question = (cells[0] ?? "").replace(/\*\*/g, "").trim();
          if (/^обсуждаемые вопросы$/i.test(question)) continue;
          const decision = summaryCellToPlain(cells[1] ?? "");
          if (question || decision) summary.push({ question, decision });
        }
        i = next - 1;
      }
      topic = null;
      label = null;
      continue;
    }

    const labelled = trimmed.match(
      /^\*\*(Слушали|Обсудили|Решили):\*\*\s*(.*)$/i,
    );
    if (labelled && topic) {
      const key = labelled[1].toLowerCase();
      label =
        key === "слушали"
          ? "listened"
          : key === "обсудили"
            ? "discussed"
            : "decided";
      topic[label] = labelled[2].trim();
      continue;
    }

    if (topic && label && trimmed) {
      // • тоже маркер списка: buildProtocolBodyXml рендерит пункты через "• ",
      // и если пользователь при правке наберёт такую же строку, маркер иначе
      // уедет в текст поля вместо того, чтобы быть снятым (см. B4).
      const value = trimmed.replace(/^[-*•]\s+/, "");
      topic[label] = topic[label] ? `${topic[label]}\n${value}` : value;
    }
  }

  return { topics, summary };
}

function parseApproval(body: string[]) {
  const start = firstTableIndex(body);
  if (start < 0) return null;

  const { rows } = parseTableRows(body, start);
  const data = rows.filter((cells) => !/^\*\*Со стороны/i.test(cells[0] ?? ""));
  if (data.length === 0) return null;

  const [orgRow, ...signatureRows] = data;

  const org = (s: string) => s.replace(/\*\*/g, "").replace(/:\s*$/, "").trim();
  const signatory = (s: string) =>
    s
      .replace(/\s*\/_+\s*$/, "")
      .replace(/^_+$/, "")
      .trim();

  return {
    customer: {
      organization: org(orgRow[0] ?? ""),
      signatories: signatureRows
        .map((r) => signatory(r[0] ?? ""))
        .filter(Boolean),
    },
    executor: {
      organization: org(orgRow[1] ?? ""),
      signatories: signatureRows
        .map((r) => signatory(r[1] ?? ""))
        .filter(Boolean),
    },
  };
}

export function markdownToProtocol(markdown: string): Protocol {
  // Раньше нормализация «1. Раздел» → «## 1. Раздел» применялась только для показа
  // в панели (lib/document/formatting.ts). На сервер уходил сырой markdown, и
  // старые протоколы без «## N.» разбирались в пустой каркас (см. A2 в отчёте).
  const normalized = fixProtocolSectionHeadingsInMarkdown(
    stripUnresolvedMarkers(markdown),
  );
  const lines = normalized.replace(/\r\n?/g, "\n").split("\n");
  const { preamble, sections } = splitSections(lines);

  const head = parsePreamble(preamble);
  const agendaSection = findSection(sections, /^Повестка/i);
  const participantsSection = findSection(sections, /^Участники/i);
  const contentSection = findSection(sections, /^Содержание встречи/i);
  const approvalSection = findSection(sections, /^Согласовано/i);
  const dateSection = findSection(sections, /^Дата собрания/i);

  // Раздел «Дата собрания» авторитетнее шапки: пользователь правит именно его.
  const sectionDate = dateSection?.title
    .replace(/^Дата собрания:\s*/i, "")
    .trim();

  const participants = participantsSection
    ? parseParticipants(participantsSection.body)
    : { customer: emptySide(), executor: emptySide() };

  const content = contentSection
    ? parseContent(contentSection.body)
    : { topics: [], summary: [] };

  const approval = approvalSection ? parseApproval(approvalSection.body) : null;

  return coerceProtocolPartial({
    protocolNumber: head.protocolNumber,
    meetingDate: sectionDate || head.meetingDate,
    protocolTitle: head.protocolTitle,
    contractNumber: head.contractNumber,
    contractDate: head.contractDate,
    contractSubject: head.contractSubject,
    agenda: { items: agendaSection ? parseAgenda(agendaSection.body) : [] },
    participants,
    meetingContent: content,
    approval: approval ?? {
      customer: { organization: "", signatories: [] },
      executor: { organization: "", signatories: [] },
    },
  });
}
