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

const PROTOCOL_SECTION_HEADING_RX =
  /^(\d{1,2})\.\s+(Дата встречи|Повестка|Участники|Термины и определения|Сокращения и обозначения|Содержание встречи|Вопросы|Решения|Открытые вопросы|Согласовано)\b(.*)$/i;

/**
 * Старые протоколы: «4. Термины…» + «1. ФЗ…» рендерились как один список 4–7.
 * Превращаем строки разделов в markdown-заголовки.
 */
export function fixProtocolSectionHeadingsInMarkdown(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (/^#{1,6}\s+\d{1,2}\./.test(trimmed)) return line;
    const m = trimmed.match(PROTOCOL_SECTION_HEADING_RX);
    if (!m) return line;
    const indent = line.slice(0, line.length - trimmed.length);
    return `${indent}## ${m[1]}. ${m[2]}${m[3]}`;
  }).join('\n');
}
