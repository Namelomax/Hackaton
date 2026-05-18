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
