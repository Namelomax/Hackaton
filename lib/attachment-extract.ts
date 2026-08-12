/**
 * Извлечение текста из вложений (PDF/DOCX/XLSX/PPTX/текст).
 *
 * ЕДИНСТВЕННЫЙ серверный диспетчер: и /api/chat, и /api/anonymize ходят сюда.
 * Раньше у чата была своя копия разбора по типам; копии разошлись — у одной
 * было определение кодировки, у другой нет, — и это стоило утечки ПДн.
 */
import { decodeTextBytes } from '@/lib/text-encoding';

export async function urlToBuffer(urlOrData?: string | null): Promise<Buffer | null> {
  if (!urlOrData) return null;
  if (urlOrData.startsWith('data:')) {
    const match = String(urlOrData).match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) return null;
    try {
      return Buffer.from(match[1], 'base64');
    } catch {
      return null;
    }
  }
  if (urlOrData.startsWith('https://') || urlOrData.startsWith('http://')) {
    try {
      const resp = await fetch(urlOrData);
      if (!resp.ok) {
        console.warn('[urlToBuffer] Fetch failed:', resp.status, urlOrData);
        return null;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      console.warn('[urlToBuffer] Fetch error:', err);
      return null;
    }
  }
  return null;
}

export function guessFileExt(att: any): string {
  const name = String(att?.name || att?.filename || '').trim();
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return (m?.[1] ?? '').toLowerCase();
}

export function bestEffortBinaryText(buf: Buffer): string | null {
  if (!buf || buf.length < 8) return null;
  const candidates: string[] = [];
  try { candidates.push(buf.toString('utf8')); } catch {}
  try { candidates.push(buf.toString('utf16le')); } catch {}
  try { candidates.push(buf.toString('latin1')); } catch {}
  const clean = (raw: string) =>
    String(raw ?? '')
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]+/g, ' ')
      .replace(/\u0000+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  const extractReadableRuns = (text: string) => {
    const runs = text.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\s.,:;!?()\[\]"'«»\-–—\/\\]{40,}/g);
    if (!runs?.length) return '';
    return runs.map((r) => clean(r)).filter(Boolean).join('\n');
  };
  let best = '';
  for (const c of candidates) {
    const runs = extractReadableRuns(c);
    if (runs.length > best.length) best = runs;
  }
  const cleaned = clean(best);
  return cleaned.length >= 40 ? cleaned : null;
}

export async function extractLegacyDoc(buf: Buffer): Promise<string | null> {
  try {
    const WordExtractor = (await import('word-extractor')).default;
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buf);
    const text = doc.getBody()?.trim();
    return text || null;
  } catch (error) {
    console.error('word-extractor parse failed:', error);
    return null;
  }
}

async function extractPdf(att: any): Promise<string | null> {
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(buf);
    return parsed?.text?.trim() || null;
  } catch {
    return null;
  }
}

async function extractDoc(att: any): Promise<string | null> {
  const mt = att?.mediaType || att?.mimeType || '';
  const isDocx = mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const buf = await urlToBuffer(att?.url || att?.data);
  if (!buf) return null;
  if (isDocx || guessFileExt(att) === 'docx') {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      const cleaned = result.value.trim();
      if (cleaned) return cleaned;
    } catch {}
  }
  const extracted = await extractLegacyDoc(buf);
  if (extracted) return extracted;
  return bestEffortBinaryText(buf);
}

async function extractXlsx(att: any): Promise<string | null> {
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;
  try {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buf, { type: 'buffer' });
    let text = '';
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      text += `Sheet: ${sheetName}\n`;
      text += XLSX.utils.sheet_to_txt(sheet);
      text += '\n\n';
    });
    const cleaned = text.trim();
    if (cleaned) return cleaned;
  } catch {}
  return bestEffortBinaryText(buf);
}

async function extractPptx(att: any): Promise<string | null> {
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;
  const mt = att.mediaType || att.mimeType;
  const isPptx = mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (isPptx || guessFileExt(att) === 'pptx') {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buf);
      const slideFiles = Object.keys(zip.files)
        .filter((name) => name.match(/^ppt\/slides\/slide\d+\.xml$/))
        .sort((a, b) => {
          const na = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || '0');
          const nb = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || '0');
          return na - nb;
        });
      let text = '';
      for (const fileName of slideFiles) {
        const content = await zip.file(fileName)?.async('string');
        if (content) {
          const slideText = content.match(/<a:t>(.*?)<\/a:t>/g)
            ?.map((t) => t.replace(/<\/?a:t>/g, ''))
            .join(' ') || '';
          if (slideText.trim()) text += `${slideText}\n\n`;
        }
      }
      const cleaned = text.trim();
      if (cleaned) return cleaned;
    } catch {}
  }
  return bestEffortBinaryText(buf);
}

/**
 * Декодирование текстового буфера. Реализация — в `lib/text-encoding.ts`,
 * общем модуле с браузером: раньше эта логика жила только в /api/chat, а
 * канонический `extractAttachmentText` (его использует /api/anonymize) делал
 * `buf.toString('utf8')` и получал из cp1251 мойибаке.
 */
export function decodeTextBuffer(buf: Buffer): string | null {
  return decodeTextBytes(buf);
}

/** Текстовые расширения, которые читаем как текст, а не как бинарь. */
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml']);

/** Извлечь текст из одного вложения. Возвращает null, если не удалось. */
export async function extractAttachmentText(att: any): Promise<string | null> {
  const mt = att?.mediaType || att?.mimeType || '';
  const ext = guessFileExt(att);
  // Прямой текст
  if (typeof att?.content === 'string' && att.content.trim()) return att.content.trim();
  try {
    if (mt === 'application/pdf' || ext === 'pdf') return await extractPdf(att);
    if (
      mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mt === 'application/msword' || ext === 'doc' || ext === 'docx'
    ) return await extractDoc(att);
    if (
      mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mt === 'application/vnd.ms-excel' || ext === 'xls' || ext === 'xlsx'
    ) return await extractXlsx(att);
    if (
      mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mt === 'application/vnd.ms-powerpoint' || ext === 'ppt' || ext === 'pptx'
    ) return await extractPptx(att);
    // RTF — не текст: разметка забивает содержимое, читаем best-effort.
    if (mt === 'application/rtf' || mt === 'text/rtf' || ext === 'rtf') {
      const buf = await urlToBuffer(att?.url || att?.data);
      return buf ? bestEffortBinaryText(buf) : null;
    }
    if (mt.startsWith('text/') || TEXT_EXTS.has(ext)) {
      const buf = await urlToBuffer(att?.url || att?.data);
      if (!buf) return null;
      // Именно здесь была утечка ПДн: раньше стояло buf.toString('utf8').
      const decoded = decodeTextBuffer(buf)?.trim();
      return decoded || bestEffortBinaryText(buf);
    }
  } catch {}
  // Фолбек
  const buf = await urlToBuffer(att?.url || att?.data);
  return buf ? bestEffortBinaryText(buf) : null;
}
