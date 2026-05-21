/** Очистка текста полей протокола перед выводом в markdown / DOCX. */

const BOILERPLATE_RX =
  /есть\s+ли\s+у\s+вас\s+другие|возможно,?\s+я\s+что[-–—\s]?то\s+пропустил|которые\s+стоит\s+включить/i;

const CHAT_ARTIFACT_RX =
  /\bверно\??\s*$/i;

/** Хвост « 2.** » / « 3. » от склеенных пунктов списка в ответе модели. */
const TRAILING_NUMBERED_JUNK_RX = /(?:\s+\d+\.\s*\*+\s*|\s+\d+\.\s*)+$/;

/** [ТС: 00:16:11], {{ТС:…}}, обломки вроде «00:16:11].:». */
const TIMECODE_RX =
  /\{\{ТС:\s*[^}]+\}\}|\[ТС:\s*[^\]]+\]|\[TC:\s*[^\]]+\]|\b\d{1,2}:\d{2}(?::\d{2})?\]\.?:?/gi;

export function stripProtocolTimecodes(text: string): string {
  return String(text ?? '')
    .replace(TIMECODE_RX, '')
    .replace(/\s+\.\s*$/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function stripChatArtifacts(text: string): string {
  let s = String(text ?? '').trim();
  s = s.replace(CHAT_ARTIFACT_RX, '').trim();
  s = s.replace(/\*\s+/g, '').replace(/\s+\*/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  return s.trim();
}

/** Мета-фразы ассистента, не входящие в повестку. */
export function isAgendaMetaLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length < 12) return true;
  return (
    /^(отлично|теперь|перейд|переходим|предлагаю|на основе|уточним|верно\??|нужно ли)/i.test(t) ||
    /выделил основные темы|основные темы обсуждения|добавить в повестку|пропустить его/i.test(t) ||
    /переходим к следующему пункту/i.test(t) ||
    /в расшифровке обсуждал/i.test(t) ||
    /^повестка обновлена/i.test(t)
  );
}

/** Убирает встроенные markdown-таблицы и «Резюме:» из блока Обсудили/Решили. */
export function stripEmbeddedMarkdownTable(text: string): string {
  let s = String(text ?? '');
  const resumeIdx = s.search(/\n\s*Резюме\s*:/i);
  if (resumeIdx >= 0) s = s.slice(0, resumeIdx);
  const lines = s.split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^\|/.test(t)) return false;
    if (/^\|?\s*:?-{2,}/.test(t)) return false;
    return true;
  });
  return lines.join('\n').trim();
}

/** Нумерованные решения — каждый пункт с новой строки. */
export function formatDecidedForOutput(text: string): string {
  let s = stripEmbeddedMarkdownTable(stripChatArtifacts(stripProtocolTimecodes(text)));
  if (!s) return '';
  s = s.replace(/(?:^|\n)\s*(\d+)[.)]\s+/g, '\n$1. ');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export function cleanProtocolText(text: string): string {
  let s = String(text ?? '').trim();
  if (!s) return '';

  s = stripProtocolTimecodes(s);
  s = stripChatArtifacts(s);
  s = stripEmbeddedMarkdownTable(s);
  s = s.replace(BOILERPLATE_RX, '').trim();
  s = s.replace(TRAILING_NUMBERED_JUNK_RX, '').trim();
  s = s.replace(/^\s*[-*+]\s+/, '');
  s = s.replace(/^\s*\d+[.)]\s+/, '');
  s = normalizeMarkdownBold(s);
  return s.trim();
}

/** Убирает пробелы внутри **…** и снимает «висячие» пары звёздочек. */
export function normalizeMarkdownBold(text: string): string {
  let s = text;
  for (let i = 0; i < 6; i++) {
    s = s.replace(/\*\*\s+/g, '**');
    s = s.replace(/\s+\*\*/g, '**');
  }

  const count = (s.match(/\*\*/g) || []).length;
  if (count % 2 === 1) {
    s = s.replace(/\*\*/g, '');
  }
  s = s.replace(/\*(?!\*)/g, '');
  return s.trim();
}

export function isProtocolBoilerplateLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 8) return true;
  return BOILERPLATE_RX.test(t);
}

/** Строка раздела как в Word-шаблоне: «1.\tЗаголовок». */
export function formatPlainSectionLine(sectionNum: number, title: string): string {
  return `${sectionNum}.\t${title.trim()}\n`;
}

/** @deprecated Используйте formatPlainSectionLine — markdown-заголовки ломают нумерацию в DOCX. */
export function formatProtocolSectionHeading(sectionNum: number, title: string): string {
  return formatPlainSectionLine(sectionNum, title) + '\n';
}

export function formatAgendaItem(index: number, text: string): string {
  const body = cleanProtocolText(text);
  if (!body) return '';
  return `${index + 1})\t${body}\n`;
}

export function formatMeetingQuestionItem(index: number, text: string): string {
  const body = cleanProtocolText(text);
  if (!body) return '';
  return `${index + 1})\t${body}\n`;
}

export function isMarkdownTableSeparatorRow(cells: string[]): boolean {
  if (cells.length < 2) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()) || /^[-–—:\s|]+$/i.test(c.trim()));
}

export function isValidParticipantRow(fullName: string, position: string): boolean {
  const fn = fullName.trim();
  const pos = position.trim();
  if (!fn && !pos) return false;
  if (/^(фио|должность|роль|сторона|заказчик|исполнитель)$/i.test(fn)) return false;
  if (/^(сторона|заказчик|исполнитель)$/i.test(pos)) return false;
  return !isMarkdownTableSeparatorRow([fn, pos]);
}

const PROTOCOL_SECTION_HEADING_RX =
  /^(\d{1,2})\.\s+(Дата собрания|Дата встречи|Повестка|Участники|Содержание встречи|Согласовано)\b(.*)$/i;

export function fixAgendaHeadingInMarkdown(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const trimmed = line.trimStart();
    const m = trimmed.match(/^(#{1,6}\s+)?2\.\s+Повестка:\s*(.+)$/i);
    if (!m?.[2]?.trim()) return line;
    const indent = line.slice(0, line.length - trimmed.length);
    return `${indent}2.\tПовестка:\n\n${indent}${m[2].trim()}`;
  }).join('\n');
}

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
      if (/^#{1,6}\s+\d{1,2}\./.test(trimmed)) {
        return trimmed.replace(/^#{1,6}\s+(\d{1,2})\.\s*/, '$1.\t');
      }
      const m = trimmed.match(PROTOCOL_SECTION_HEADING_RX);
      if (!m) return line;
      const indent = line.slice(0, line.length - trimmed.length);
      return `${indent}${m[1]}.\t${m[2]}${m[3]}`;
    })
    .join('\n');
  s = fixAgendaHeadingInMarkdown(s);
  return stripDuplicateMarkdownTableSeparators(s);
}
