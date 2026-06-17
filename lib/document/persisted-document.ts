import type { DocumentState } from '@/lib/document/types';

const DOCX_META_START = '---DOCX_META---';
const DOCX_META_END = '---DOCX_META_END---';

export type PersistedDocxMeta = { filename: string; content: string };

/** Сохраняем DOCX (base64) вместе с markdown в `document_content`, чтобы после перезагрузки скачивание было одинаковым. */
export function packDocumentContentForDb(
  markdown: string,
  docx?: PersistedDocxMeta | null,
): string {
  const body = String(markdown ?? '').trim();
  if (!docx?.content?.trim()) return body;
  const meta = JSON.stringify({
    filename: docx.filename || 'Протокол.docx',
    content: docx.content,
  });
  return `${DOCX_META_START}\n${meta}\n${DOCX_META_END}\n\n${body}`;
}

export function unpackDocumentContentFromDb(stored?: string | null): {
  markdown: string;
  docxData?: PersistedDocxMeta;
} {
  const raw = String(stored ?? '');
  if (!raw.includes(DOCX_META_START)) {
    return { markdown: raw };
  }
  const start = raw.indexOf(DOCX_META_START);
  const end = raw.indexOf(DOCX_META_END);
  if (start < 0 || end < 0 || end <= start) {
    return { markdown: raw };
  }
  try {
    const json = raw.slice(start + DOCX_META_START.length, end).trim();
    const meta = JSON.parse(json) as PersistedDocxMeta;
    const markdown = raw.slice(end + DOCX_META_END.length).replace(/^\s+/, '');
    if (meta?.content) {
      return { markdown, docxData: meta };
    }
  } catch {
    // ignore
  }
  return { markdown: raw };
}

export function documentStateFromStored(
  stored?: string | null,
  titleFallback?: string,
): DocumentState {
  const { markdown, docxData } = unpackDocumentContentFromDb(stored);
  return {
    title: titleFallback || 'Протокол',
    content: markdown,
    isStreaming: false,
    ...(docxData ? { docxData } : {}),
  };
}
