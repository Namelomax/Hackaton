/**
 * Определение кодировки текстового файла. Общий модуль для сервера и браузера.
 *
 * ЗАЧЕМ. Кодировка по умолчанию в русской Windows — windows-1251, и расшифровки
 * совещаний регулярно приезжают именно в ней. Прочитать такой буфер как UTF-8
 * ошибки не вызовет: получится мойибаке. А в мойибаке ни регулярки, ни NER не
 * находят ни ФИО, ни телефонов — то есть персональные данные тихо проходят мимо
 * анонимизации и уезжают в облако. Отсюда требование: любой путь чтения текста
 * (сервер, браузер, любой роут) обязан идти через эти функции.
 *
 * Модуль намеренно без зависимостей и без Node API: работает с Uint8Array,
 * поэтому одинаково живёт в бандле браузера и на сервере.
 */

/**
 * Оценка «читаемости» декодированной строки. Кириллица весит больше,
 * управляющие символы и `�` штрафуются.
 *
 * Без такой оценки мойибаке не поймать: latin1 декодирует ЛЮБЫЕ байты без
 * единого `�`, поэтому «получилось без ошибок» ничего не значит.
 */
export function textReadabilityScore(s: string): number {
  if (!s) return -1;
  let good = 0;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) { bad += 5; continue; }                     // replacement char
    if (c === 9 || c === 10 || c === 13) { good += 1; continue; } // tab/CR/LF
    if (c >= 32 && c < 127) { good += 1; continue; }              // ASCII печатаемые
    if (c >= 0x0400 && c <= 0x04ff) { good += 2; continue; }      // кириллица
    if (c >= 0x2010 && c <= 0x2069) { good += 1; continue; }      // — « » … типографика
    if (c < 32) { bad += 2; continue; }                           // прочие control
    bad += 1;                                                     // латиница-мойибаке и т.п.
  }
  const total = good + bad;
  return total === 0 ? -1 : (good - bad) / total;
}

/** Кандидаты перебора, когда однозначного признака нет. Порядок не важен. */
const FALLBACK_ENCODINGS = ['windows-1251', 'koi8-r', 'utf-16le', 'latin1'];

/**
 * Декодирует байты текстового файла, определяя кодировку.
 *
 * Порядок: BOM (однозначно) → строгий UTF-8 (если валиден — это он) →
 * перебор кандидатов с выбором по читаемости.
 */
export function decodeTextBytes(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length === 0) return null;

  // BOM — однозначная кодировка, гадать не нужно.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // Строгий UTF-8: почти любой не-UTF-8 буфер здесь упадёт.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {}

  let best: { text: string; score: number } | null = null;
  for (const enc of FALLBACK_ENCODINGS) {
    try {
      const text = new TextDecoder(enc).decode(bytes);
      const score = textReadabilityScore(text);
      if (!best || score > best.score) best = { text, score };
    } catch {}
  }
  return best?.text ?? null;
}
