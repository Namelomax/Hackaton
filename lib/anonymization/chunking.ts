/**
 * Резка текста на куски с СОХРАНЕНИЕМ offset'ов — порт `anonymizer/chunking.py`.
 *
 * Зачем это здесь. GLiNER-шлюз отвергает вход длиннее 50 000 символов (HTTP 422),
 * но поднимать размер куска до этого лимита НЕЛЬЗЯ: сама модель перестаёт видеть
 * текст примерно после 1800 символов и молча возвращает пустой список сущностей.
 * Тихий пропуск хуже явной ошибки — документ «анонимизируется» успешно, а ПДн
 * уезжают в облако. Поэтому рабочий размер куска — 800 символов (см.
 * `RemoteGLiNERConfig.max_chars` в Python-версии).
 *
 * Контракт по offset'ам точный: `text.slice(offset, offset + chunk.length) === chunk`.
 * Он держится на том, что исходный текст склеен из строк через "\n", поэтому
 * группа подряд идущих строк, склеенная через "\n", — это ровно подстрока
 * оригинала, и локальные координаты сущностей переводятся в глобальные простым
 * сложением с offset.
 */

/** Кусок текста и его смещение в исходном тексте. */
export interface TextChunk {
  offset: number;
  chunk: string;
}

/**
 * Разрезать `text` на куски не длиннее ~`maxChars`.
 *
 * @param group `true` (LLM-режим) — паковать подряд идущие строки в один кусок,
 *   чтобы уменьшить число вызовов модели. `false` (GLiNER-режим) — по одной
 *   строке на кусок, слишком длинные строки режутся по пробелам: маленькие
 *   сфокусированные входы дают span-модели заметно более высокую полноту.
 */
export function chunkText(
  text: string,
  maxChars: number,
  { group = true }: { group?: boolean } = {},
): TextChunk[] {
  if (maxChars <= 0) throw new Error(`chunkText: maxChars должен быть > 0, получено ${maxChars}`);
  if (!text) return [];
  if (!group) return perLine(text, maxChars);

  const out: TextChunk[] = [];
  let pos = 0;
  let buf: string[] = [];
  let bufStart = 0;
  let bufLen = 0;

  for (const line of text.split('\n')) {
    const lineSpan = line.length + 1; // +1 — на "\n", которым строка была склеена
    if (buf.length > 0 && bufLen + line.length > maxChars) {
      out.push({ offset: bufStart, chunk: buf.join('\n') });
      buf = [];
      bufLen = 0;
    }
    if (buf.length === 0) bufStart = pos;
    buf.push(line);
    bufLen += lineSpan;
    pos += lineSpan;
  }
  if (buf.length > 0) out.push({ offset: bufStart, chunk: buf.join('\n') });

  return out.filter((c) => c.chunk.trim().length > 0);
}

/** По одному куску на строку; слишком длинная строка режется по ближайшему пробелу слева. */
function perLine(text: string, maxChars: number): TextChunk[] {
  const out: TextChunk[] = [];
  let pos = 0;

  for (const line of text.split('\n')) {
    if (line.length <= maxChars) {
      if (line.trim()) out.push({ offset: pos, chunk: line });
    } else {
      let i = 0;
      while (i < line.length) {
        let end = Math.min(i + maxChars, line.length);
        if (end < line.length) {
          // Python-версия ищет rfind(" ", i, end) — верхняя граница исключающая,
          // поэтому здесь end - 1, а не end.
          const sp = line.lastIndexOf(' ', end - 1);
          // lastIndexOf может уйти левее i — тогда пробела внутри окна нет и
          // режем жёстко по maxChars, иначе цикл не сдвинется и зациклится.
          if (sp > i) end = sp;
        }
        if (line.slice(i, end).trim()) out.push({ offset: pos + i, chunk: line.slice(i, end) });
        i = end;
      }
    }
    pos += line.length + 1;
  }

  return out;
}
