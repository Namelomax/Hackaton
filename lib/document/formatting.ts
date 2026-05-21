import { fixProtocolSectionHeadingsInMarkdown } from '@/lib/protocol-markdown-format';
import { protocolContentToPreviewMarkdown } from '@/lib/protocol-preview-markdown';

/**
 * Убирает лишние маркеры ненумерованного списка перед нумерованными блоками
 * (типичный артефакт генерации: «•», пустая строка, затем 1. 2. 3.).
 */
export function normalizeDocumentPanelMarkdown(raw: string): string {
  if (!raw) return '';
  let s = raw.replace(/\r\n?/g, '\n');
  if (/^ПРОТОКОЛ\s*№/im.test(s.trim())) {
    return protocolContentToPreviewMarkdown(s);
  }
  s = fixProtocolSectionHeadingsInMarkdown(s);
  // Строка только из маркера списка без текста
  s = s.replace(/(^|\n)[ \t]*(?:[-*•])[ \t]*(?=\n)/g, '$1');
  // Маркер списка с пустой строкой перед нумерованным списком
  s = s.replace(/(^|\n)[ \t]*(?:[-*•])[ \t]*\n+(?=\s*\d+\.\s)/g, '$1\n');
  return s;
}

export function formatDocumentContent(raw: string) {
  if (!raw) return '';
  const normalized = raw.replace(/\r\n?/g, '\n');
  // Preserve manual indentation by converting leading spaces on each line to non-breaking spaces
  return normalized.replace(/^(\s+)/gm, (m) => m.replace(/ /g, '\u00A0'));
}

export function normalizeMarkdownForDocx(raw: string) {
  if (!raw) return '';
  let text = raw.replace(/\r\n?/g, '\n');

  // Normalize bullet points into markdown list items.
  text = text.replace(/^[ \t]*•\s*/gm, '- ');
  text = text.replace(/([^\n])\s*•\s*/g, '$1\n- ');

  return text;
}

export function buildDocxMarkdown(title: string, content: string) {
  const body = String(content || '').trim();
  const firstLine = body.split('\n')[0]?.trim() || '';
  const hasHeading = /^#\s+/.test(firstLine);
  const hasTitleLine = /^ПРОТОКОЛ ОБСЛЕДОВАНИЯ\b/i.test(firstLine);
  const withTitle = hasHeading || hasTitleLine ? body : `# ${title}\n\n${body}`;
  return normalizeMarkdownForDocx(withTitle);
}

export function extractTitleFromMarkdown(markdown?: string | null): string | null {
  const text = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return null;
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#\s+(.+?)\s*$/);
    if (m?.[1]) return m[1].trim();
    break;
  }
  return null;
}

export function sanitizeFilename(input: string, fallback: string) {
  const trimmed = String(input || '').trim();
  const safe = (trimmed || fallback)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 140);
  return safe || fallback;
}
