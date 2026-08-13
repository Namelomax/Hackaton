/**
 * Кэш извлечённого текста вложений.
 *
 * ЗАЧЕМ. Один и тот же файл разбирался снова и снова:
 *   • `/api/anonymize` разбирает его для превью «что уйдёт в облако»;
 *   • `/api/chat` разбирает его же для контекста модели;
 *   • и делает это ЗАНОВО на каждом ходу диалога — цикл извлечения идёт по
 *     всей истории сообщений, а data-URI вложения хранится в переписке и
 *     приезжает с каждым запросом.
 * На расшифровке в сто страниц это pdf-parse/xlsx на каждое сообщение
 * пользователя, при том что содержимое файла измениться не может.
 *
 * Ключ — хэш самого содержимого (data-URI или ссылки), поэтому кэш общий для
 * всех роутов, диалогов и пользователей: одинаковые байты дают одинаковый
 * текст. Утечки между пользователями тут нет — совпадение ключа означает
 * побайтово тот же файл.
 *
 * Живёт в памяти процесса: переживать перезапуск незачем, а инвалидация не
 * нужна вовсе — содержимое неизменяемо по построению ключа.
 */
import crypto from 'node:crypto';

/** Сколько разных файлов держим. Расшифровки крупные, глубина не нужна. */
const MAX_ENTRIES = 32;
/** Потолок по объёму текста, чтобы кэш не рос неограниченно. */
const MAX_TOTAL_CHARS = 8_000_000;

type Cache = { map: Map<string, string>; chars: number };

/**
 * Держим на globalThis: в dev-режиме Next пересоздаёт модули при HMR, и
 * обычная модульная переменная обнулялась бы на каждой правке.
 */
function store(): Cache {
  const g = globalThis as unknown as { __attachmentTextCache?: Cache };
  if (!g.__attachmentTextCache) g.__attachmentTextCache = { map: new Map(), chars: 0 };
  return g.__attachmentTextCache;
}

/** Ключ по содержимому вложения. null — кэшировать нечего. */
export function attachmentCacheKey(att: any): string | null {
  const src = att?.url || att?.data;
  if (typeof src !== 'string' || src.length === 0) return null;
  return crypto.createHash('sha1').update(src).digest('hex');
}

export function getCachedAttachmentText(key: string | null): string | undefined {
  if (!key) return undefined;
  const c = store();
  const hit = c.map.get(key);
  if (hit === undefined) return undefined;
  // LRU: освежаем позицию — Map сохраняет порядок вставки.
  c.map.delete(key);
  c.map.set(key, hit);
  return hit;
}

export function setCachedAttachmentText(key: string | null, text: string): void {
  if (!key || !text) return;
  const c = store();
  if (c.map.has(key)) {
    c.chars -= c.map.get(key)!.length;
    c.map.delete(key);
  }
  c.map.set(key, text);
  c.chars += text.length;

  // Вытесняем самые давние, пока не влезем в оба лимита.
  while (c.map.size > MAX_ENTRIES || c.chars > MAX_TOTAL_CHARS) {
    const oldest = c.map.keys().next();
    if (oldest.done) break;
    c.chars -= c.map.get(oldest.value)?.length ?? 0;
    c.map.delete(oldest.value);
  }
}

/** Только для тестов: очистить кэш между прогонами. */
export function __clearAttachmentCache(): void {
  const c = store();
  c.map.clear();
  c.chars = 0;
}

/** Только для тестов: текущее состояние. */
export function __attachmentCacheStats(): { entries: number; chars: number } {
  const c = store();
  return { entries: c.map.size, chars: c.chars };
}
