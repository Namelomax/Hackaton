import type { Protocol } from '@/lib/schemas/protocol-schema';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DocumentDeltaPayload = { content: string; replace?: boolean };

type WriteDataFn = (payload: { type: string; data: unknown; transient?: boolean }) => void;

/** Разбивает markdown протокола на фрагменты для постепенной отдачи в панель. */
export function splitProtocolMarkdownForStream(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push(buf.join('\n') + (buf[buf.length - 1] === '' ? '' : '\n'));
    buf = [];
  };

  for (const line of lines) {
    buf.push(line);
    const t = line.trim();
    if (/^\d+\.\t/.test(t) || t === 'Резюме:' || /^ПРОТОКОЛ\s*№/i.test(t)) {
      if (buf.length > 1) {
        const last = buf.pop()!;
        flush();
        buf = [last];
      }
    }
    if (buf.length >= 12) flush();
  }
  flush();
  if (chunks.length === 0 && markdown.trim()) return [markdown];
  return chunks;
}

export function emitDocumentDelta(writeData: WriteDataFn, content: string, replace: boolean) {
  if (!content) return;
  const payload: DocumentDeltaPayload = { content, replace };
  writeData({ type: 'data-documentDelta', data: payload, transient: true });
}

export async function streamProtocolToPanel(
  markdown: string,
  writeData: WriteDataFn,
  options?: { title?: string; chunkDelayMs?: number },
): Promise<void> {
  writeData({ type: 'data-clear', data: null, transient: true });
  if (options?.title?.trim()) {
    writeData({ type: 'data-title', data: options.title.trim(), transient: true });
  }

  const chunks = splitProtocolMarkdownForStream(markdown);
  const delay = options?.chunkDelayMs ?? 28;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    emitDocumentDelta(writeData, chunk, i === 0);
    if (delay > 0) await sleep(delay);
  }

  writeData({ type: 'data-finish', data: null, transient: true });
}
