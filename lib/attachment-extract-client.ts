/**
 * Извлечение текста из вложений НА КЛИЕНТЕ, до отправки на сервер.
 *
 * Зачем: раньше вложение уходило в /api/anonymize целиком, base64-строкой
 * внутри JSON. У серверless-функции Vercel есть жёсткий лимит на размер тела
 * запроса (~4.5 МБ), причём срабатывает он ДО вызова функции — платформа
 * отвечает 413 с текстом «Request Entity Too Large», который не является JSON.
 * На расшифровке в 100 страниц это и происходило: сам .docx весит немного, но
 * base64 раздувает его на треть, и лимит переставал быть теоретическим.
 *
 * Текст того же документа меньше бинарника примерно на порядок, а серверу для
 * анонимизации нужен именно текст — `/api/anonymize` принимает поле `text`
 * наравне с `files`. Поэтому извлекаем в браузере и шлём только текст;
 * если формат не поддержан, молча возвращаем null и вложение уходит по-старому,
 * как раньше (серверное извлечение в lib/attachment-extract.ts никуда не делось).
 */
import { decodeTextBytes } from '@/lib/text-encoding';

/** Максимальный размер тела запроса, который принимает платформа. */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  // Без флага /s: цель компиляции ниже es2018. [\s\S] делает то же самое —
  // захватывает и переводы строк, если они попадут в base64-хвост.
  const match = dataUrl.match(/^data:[^;]*;base64,([\s\S]*)$/i);
  if (!match) return null;
  try {
    const bin = atob(match[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function extFromName(name: string): string {
  return (name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();
}

/**
 * Вернуть текст вложения или null, если формат не по зубам браузеру
 * (тогда вызывающий код отправит файл целиком, как раньше).
 */
export async function extractAttachmentTextInBrowser(att: {
  url?: string;
  data?: string;
  filename?: string;
  name?: string;
  mediaType?: string;
  mimeType?: string;
}): Promise<string | null> {
  const src = att.url || att.data;
  if (!src || !src.startsWith('data:')) return null;

  const name = String(att.filename || att.name || '');
  const ext = extFromName(name);
  const mime = String(att.mediaType || att.mimeType || '').toLowerCase();

  // Простой текст — декодируем без библиотек.
  const isPlain =
    ['txt', 'md', 'markdown', 'csv', 'json', 'log'].includes(ext) ||
    mime.startsWith('text/') ||
    mime === 'application/json';
  if (isPlain) {
    const bytes = dataUrlToBytes(src);
    if (!bytes) return null;
    // Через общий детектор кодировки, а не TextDecoder('utf-8') напрямую:
    // русский .txt из Windows приезжает в cp1251, и «просто utf-8» молча
    // возвращал мойибаке. Дальше по конвейеру это уже неотличимо от текста, но
    // ни NER, ни регулярки не находят в нём ПДн.
    return decodeTextBytes(bytes);
  }

  // .docx — mammoth уже есть в зависимостях, у пакета объявлен browser-билд,
  // поэтому динамический импорт в клиентском бандле подтянет именно его и не
  // потащит за собой node-only зависимости.
  const isDocx =
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (isDocx) {
    const bytes = dataUrlToBytes(src);
    if (!bytes) return null;
    try {
      const mammoth: any = await import('mammoth');
      const lib = mammoth?.default ?? mammoth;
      const res = await lib.extractRawText({
        arrayBuffer: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      });
      const value = String(res?.value ?? '').trim();
      return value || null;
    } catch (e) {
      console.warn('[attach] не удалось разобрать .docx в браузере:', e);
      return null; // отдадим файл серверу целиком
    }
  }

  // PDF/XLSX/PPTX оставляем серверу: их парсеры node-only либо тянут в бандл
  // слишком много ради редкого случая.
  return null;
}

/**
 * Подготовить полезную нагрузку для /api/anonymize: где можно — заменить
 * вложения на извлечённый текст. Возвращает и диагностику, чтобы вызывающий
 * код мог показать понятную ошибку, если размер всё равно запределен.
 */
export async function buildAnonymizePayload(
  files: any[],
  text: string,
): Promise<{ text: string; files: any[]; extractedCount: number; bytes: number }> {
  const parts: string[] = [];
  if (text && text.trim()) parts.push(text.trim());

  const leftover: any[] = [];
  let extractedCount = 0;

  for (const f of files) {
    const att = {
      url: f?.url || f?.data,
      mediaType: f?.mediaType || f?.mimeType,
      filename: f?.filename || f?.name,
    };
    const extracted = await extractAttachmentTextInBrowser(att);
    if (!extracted) {
      leftover.push(att);
      continue;
    }
    // Извлечение НЕ всегда уменьшает запрос, и это проверено замером: .docx —
    // это zip, и на чистом тексте он бывает В РАЗЫ компактнее, чем тот же текст
    // в JSON (на 100-страничном тестовом документе — 56 КБ против 454 КБ).
    // Выигрыш появляется на форматах с картинками и на сканах, где бинарник
    // тяжёлый, а текста мало. Поэтому не верим на слово, а сравниваем и берём
    // то, что меньше: цель — пролезть в лимит тела запроса, а не «извлечь
    // любой ценой».
    const asText = JSON.stringify(`Документ "${att.filename || 'документ'}":\n${extracted}`).length;
    const asFile = JSON.stringify(att).length;
    if (asText < asFile) {
      parts.push(`Документ "${att.filename || 'документ'}":\n${extracted}`);
      extractedCount += 1;
    } else {
      leftover.push(att);
    }
  }

  const merged = parts.join('\n\n');
  const bytes = new Blob([JSON.stringify({ text: merged, files: leftover })]).size;
  return { text: merged, files: leftover, extractedCount, bytes };
}
