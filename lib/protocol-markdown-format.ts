/** Очистка текста полей протокола перед выводом в markdown / DOCX. */

const BOILERPLATE_RX =
  /есть\s+ли\s+у\s+вас\s+другие|возможно,?\s+я\s+что[-–—\s]?то\s+пропустил|которые\s+стоит\s+включить/i;

/** Хвост « 2.** » / « 3. » от склеенных пунктов списка в ответе модели. */
const TRAILING_NUMBERED_JUNK_RX = /(?:\s+\d+\.\s*\*+\s*|\s+\d+\.\s*)+$/;

export function cleanProtocolText(text: string): string {
  let s = String(text ?? '').trim();
  if (!s) return '';

  s = s.replace(BOILERPLATE_RX, '').trim();
  s = s.replace(TRAILING_NUMBERED_JUNK_RX, '').trim();

  // Снять внешние маркеры списка, если попали в поле
  s = s.replace(/^\s*[-*+]\s+/, '');
  s = s.replace(/^\s*\d+[.)]\s+/, '');

  s = normalizeMarkdownBold(s);

  return s.trim();
}

/** Убирает пробелы внутри **…** и снимает «висячие» пары звёздочек. */
/** Маркеры «Срок:» / «Ответственный:» в поле решения (после снятия **). */
const DECISION_LABEL_SPLIT_RX = /(?=(?:Срок\s*:|Ответственн\w*\s*:))/i;

/** Перенос перед метками, если модель пишет «Срок:» и «Ответственный:» в одной строке. */
function normalizeDecisionLabelBreaks(s: string): string {
  return s
    .replace(/([^\n<])\s*(Срок\s*:)/gi, '$1\n$2')
    .replace(/([^\n<])\s*(Ответственн\w*\s*:)/gi, '$1\n$2');
}

/** Текст решения для DOCX / разбора: без markdown-звёздочек, переносы из &lt;br&gt; сохранены. */
export function prepareDecisionPlainText(raw: string): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/(?<!\*)\*(?!\*)/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(BOILERPLATE_RX, '').trim();
  s = s.replace(TRAILING_NUMBERED_JUNK_RX, '').trim();
  return s.trim();
}

/** Рекурсивно режет строку, если «Ответственный:» остался внутри блока после «Срок:». */
function splitLineByDecisionLabels(line: string): string[] {
  const parts = line.split(DECISION_LABEL_SPLIT_RX).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const nested = part.split(DECISION_LABEL_SPLIT_RX).map((p) => p.trim()).filter(Boolean);
    if (nested.length > 1) out.push(...splitLineByDecisionLabels(part));
    else out.push(part);
  }
  return out;
}

/** Разбивает решение на абзацы: основной текст, затем «Срок:», «Ответственный:». */
export function splitDecisionSegments(raw: string): string[] {
  let s = prepareDecisionPlainText(raw);
  if (!s) return [];
  s = normalizeDecisionLabelBreaks(s);
  return s.split(/\n+/).flatMap((line) => splitLineByDecisionLabels(line));
}

/** Строка договора в шапке документа. Пустые/плейсхолдерные поля опускаются. */
export function formatContractBlock(protocol: {
  contractNumber?: string;
  contractDate?: string;
}): string {
  // Strip leading № to avoid "№№2"
  const rawNum = prepareDecisionPlainText(protocol.contractNumber ?? '').trim().replace(/^№\s*/i, '');
  const rawDate = prepareDecisionPlainText(protocol.contractDate ?? '').trim();

  const hasNum = rawNum.length > 0 && !/не\s+указан/i.test(rawNum);
  const hasDate = rawDate.length > 0 && !/не\s+указан/i.test(rawDate);

  if (!hasNum && !hasDate) return 'Договор: не указан в расшифровке';
  if (hasNum && hasDate) return `Договор №${rawNum} от ${rawDate} г.`;
  if (hasNum) return `Договор №${rawNum}`;
  return `Договор от ${rawDate} г.`;
}

function isGenericApprovalOrg(name: string): boolean {
  return /^(заказчик|исполнитель)$/i.test(name.trim());
}

/** Организации и подписи для раздела 5: из approval, при нехватке — из участников. */
export function resolveApprovalForDocument(protocol: {
  approval: {
    customer: { organization: string; signatories: string[] };
    executor: { organization: string; signatories: string[] };
  };
  participants: {
    customer: { organizationName: string; people: Array<{ fullName: string }> };
    executor: { organizationName: string; people: Array<{ fullName: string }> };
  };
}): {
  customer: { organization: string; signatories: string[] };
  executor: { organization: string; signatories: string[] };
} {
  const pickOrg = (approvalOrg: string, participantOrg: string, fallback: string) => {
    const a = approvalOrg.trim();
    const p = participantOrg.trim();
    if (a && !isGenericApprovalOrg(a)) return a;
    if (p && !isGenericApprovalOrg(p)) return p;
    return fallback;
  };
  const pickSigs = (approvalSigs: string[], people: Array<{ fullName: string }>) => {
    const fromApproval = approvalSigs.map((s) => s.trim()).filter(Boolean);
    const fromParticipants = people.map((p) => p.fullName.trim()).filter(Boolean);
    // If participants table has more people than AI-generated signatories, use all participants
    // (prevents the model from accidentally dropping team members)
    if (fromParticipants.length > fromApproval.length) return fromParticipants;
    if (fromApproval.length > 0) return fromApproval;
    return fromParticipants;
  };

  return {
    customer: {
      organization: pickOrg(
        protocol.approval.customer.organization,
        protocol.participants.customer.organizationName,
        'Заказчик',
      ),
      signatories: pickSigs(protocol.approval.customer.signatories, protocol.participants.customer.people),
    },
    executor: {
      organization: pickOrg(
        protocol.approval.executor.organization,
        protocol.participants.executor.organizationName,
        'Исполнитель',
      ),
      signatories: pickSigs(protocol.approval.executor.signatories, protocol.participants.executor.people),
    },
  };
}

export function formatSummaryDecisionForMarkdown(raw: string): string {
  let s = prepareDecisionPlainText(raw);
  if (!s) return '';

  // Явный <br> перед метками — в GFM-ячейке таблицы это надёжнее, чем только \n
  s = s
    .replace(/([^\n<])\s*(Срок\s*:)/gi, '$1<br>$2')
    .replace(/([^\n<])\s*(Ответственн\w*\s*:)/gi, '$1<br>$2')
    .replace(/^(<br>)+/i, '');

  const parts = s
    .split(/<br\s*\/?>|\n+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) return '';

  return parts
    .map((segment) => {
      const m = segment.match(/^(Срок\s*:|Ответственн\w*\s*:)\s*([\s\S]*)/i);
      if (m) {
        const label = m[1].trim();
        const rest = m[2].trim();
        return rest ? `**${label}** ${rest}` : `**${label}**`;
      }
      return segment;
    })
    .join('<br>');
}

/** Убирает HTML-жирный из markdown перед md-to-docx — в Word иначе видны сырые &lt;strong&gt;. */
export function normalizeMarkdownBoldForDocxExport(markdown: string): string {
  let s = String(markdown ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/<strong>([^<]*)<\/strong>/gi, '**$1**');
  s = s.replace(/<\/?strong>/gi, '');
  return s;
}

/** Разбирает inline **жирный** на сегменты { text, bold } для Word (docx). */
export function parseInlineMarkdownBold(text: string): Array<{ text: string; bold: boolean }> {
  const s = String(text ?? '');
  if (!s) return [{ text: '', bold: false }];
  const segments: Array<{ text: string; bold: boolean }> = [];
  const rx = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    if (m.index > last) {
      segments.push({ text: s.slice(last, m.index), bold: false });
    }
    segments.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    segments.push({ text: s.slice(last), bold: false });
  }
  if (segments.length === 0) {
    return [{ text: s.replace(/\*\*/g, ''), bold: false }];
  }
  return segments;
}

export function normalizeMarkdownBold(text: string): string {
  let s = text;
  for (let i = 0; i < 6; i++) {
    s = s.replace(/\*\*\s+/g, '**');
    s = s.replace(/\s+\*\*/g, '**');
  }

  const count = (s.match(/\*\*/g) || []).length;
  if (count % 2 === 1) {
    // Незакрытое выделение — убираем разметку, оставляем текст
    s = s.replace(/\*\*/g, '');
  }

  return s.trim();
}

export function isProtocolBoilerplateLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 8) return true;
  return BOILERPLATE_RX.test(t);
}

/** Строка нумерованного пункта без вложенного «- 1.» (только «1. …»). */
export function formatNumberedLine(index: number, text: string): string {
  const body = cleanProtocolText(text);
  if (!body) return '';
  return `${index + 1}.\t${body}`;
}

/** Заголовок раздела протокола (##), чтобы markdown не склеивал «4.» и вложенный «1. 2. 3.». */
export function formatProtocolSectionHeading(sectionNum: number, title: string): string {
  const body = title.trim();
  return `## ${sectionNum}. ${body}\n\n`;
}

/** Строка markdown-таблицы вида | --- | --- | или | ----- | ---------- | */
export function isMarkdownTableSeparatorRow(cells: string[]): boolean {
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()) || /^[-–—:\s|]+$/i.test(c.trim()));
}

export function isValidParticipantRow(fullName: string, position: string): boolean {
  const fn = fullName.trim();
  const pos = position.trim();
  if (!fn && !pos) return false;
  if (/^(фио|должность|роль)$/i.test(fn)) return false;
  return !isMarkdownTableSeparatorRow([fn, pos]);
}

const PROTOCOL_SECTION_HEADING_RX =
  /^(\d{1,2})\.\s+(Дата собрания|Повестка|Участники|Содержание встречи|Согласовано)\b(.*)$/i;

/**
 * Старые протоколы: «4. Термины…» + «1. ФЗ…» рендерились как один список 4–7.
 * Превращаем строки разделов в markdown-заголовки.
 */
/** Повестка — только «## 2. Повестка:», нумерованные пункты отдельными абзацами. */
export function fixAgendaHeadingInMarkdown(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const trimmed = line.trimStart();
    const m = trimmed.match(/^(#{1,6}\s+)?2\.\s+Повестка:\s*(.+)$/i);
    if (!m?.[2]?.trim()) return line;
    const indent = line.slice(0, line.length - trimmed.length);
    return `${indent}## 2. Повестка:\n\n${indent}${m[2].trim()}`;
  }).join('\n');
}

/** Убирает дублирующую строку | ----- | после стандартного | --- | --- |. */
export function stripDuplicateMarkdownTableSeparators(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^\|/.test(trimmed)) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (isMarkdownTableSeparatorRow(cells) && out.length > 0) {
        const prev = out[out.length - 1]?.trim() ?? '';
        const prevCells = prev.split('|').map((c) => c.trim()).filter(Boolean);
        if (isMarkdownTableSeparatorRow(prevCells)) continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

export function fixProtocolSectionHeadingsInMarkdown(raw: string): string {
  let s = raw.replace(/\r\n?/g, '\n');
  s = s
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (/^#{1,6}\s+\d{1,2}\./.test(trimmed)) return line;
      const m = trimmed.match(PROTOCOL_SECTION_HEADING_RX);
      if (!m) return line;
      const indent = line.slice(0, line.length - trimmed.length);
      return `${indent}## ${m[1]}. ${m[2]}${m[3]}`;
    })
    .join('\n');
  s = fixAgendaHeadingInMarkdown(s);
  return stripDuplicateMarkdownTableSeparators(s);
}
