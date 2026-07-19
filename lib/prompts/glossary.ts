/**
 * Словарь замен разговорных слов/жаргона → официально-деловой стиль.
 *
 * ЗАЧЕМ: модель (особенно слабая) непостоянно заменяет жаргон по инструкции в
 * промпте. Здесь замена ДЕТЕРМИНИРОВАННАЯ (regex) и выполняется в коде перед
 * выводом протокола в DOCX — поэтому результат стабилен на 100%.
 *
 * ПОПОЛНЕНИЕ: правьте файл `data/glossary.json` (его может дополнять и админ, и
 * сам ИИ через будущий tool). Перезапуск сервера не требуется — файл
 * перечитывается с кэшем (TTL ниже). Если файла нет/он битый — используется
 * встроенный DEFAULT_GLOSSARY.
 *
 * ВАЖНО: применяется только к содержательным полям (повестка, «Обсудили»,
 * «Решили», резюме, заголовки). ФИО и названия организаций НЕ затрагиваются.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Protocol } from '@/lib/schemas/protocol-schema';

export type GlossaryEntry = {
  from: string;
  to: string;
  /** 'word' — по границам слова (по умолчанию); 'phrase' — словосочетание. */
  mode?: 'word' | 'phrase';
};

/** Запасной словарь на случай отсутствия/повреждения data/glossary.json. */
const DEFAULT_GLOSSARY: GlossaryEntry[] = [
  { from: 'доделывается', to: 'находится в стадии завершения' },
  { from: 'доделано', to: 'завершено' },
  { from: 'боли', to: 'проблемные аспекты' },
  { from: 'болевые точки', to: 'проблемные аспекты', mode: 'phrase' },
  { from: 'тайм-коды', to: 'отметки времени' },
  { from: 'локальность', to: 'локальная обработка данных' },
  { from: 'скинуть', to: 'направить' },
  { from: 'ТЗ', to: 'техническое задание' },
];

const GLOSSARY_TTL_MS = Number(process.env.GLOSSARY_TTL_MS ?? 60000);
let cache: { at: number; entries: GlossaryEntry[] } | null = null;

function glossaryFilePath(): string {
  return (
    process.env.GLOSSARY_FILE_PATH ||
    path.join(process.cwd(), 'data', 'glossary.json')
  );
}

/** Пользовательский md-глоссарий: `data/glossary.md`, строки «слово -> замена». */
function glossaryMdPath(): string {
  return (
    process.env.GLOSSARY_MD_PATH || path.join(process.cwd(), 'data', 'glossary.md')
  );
}

/**
 * Парсит md-глоссарий. Формат строки (в любом месте файла):
 *   - слово -> замена
 *   - словосочетание из нескольких слов -> другая формулировка
 *   - слово ->            (пустая замена = слово просто удаляется)
 * Строки без «->» (заголовки, комментарии) игнорируются.
 */
export function parseGlossaryMd(raw: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*(.+?)\s*(?:->|=>|→)\s*(.*?)\s*$/);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    if (!from || from.startsWith('#')) continue;
    entries.push({ from, to, mode: from.includes(' ') ? 'phrase' : 'word' });
  }
  return entries;
}

function loadEntries(): GlossaryEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < GLOSSARY_TTL_MS) return cache.entries;

  let entries: GlossaryEntry[] = DEFAULT_GLOSSARY;

  // 1. Приоритет — md-файл (правится руками и инструментом addProtocolGlossaryRule).
  let mdLoaded = false;
  try {
    const rawMd = fs.readFileSync(glossaryMdPath(), 'utf8');
    const mdEntries = parseGlossaryMd(rawMd);
    if (mdEntries.length > 0) {
      entries = mdEntries;
      mdLoaded = true;
    }
  } catch {
    // md нет — ниже пробуем json
  }

  if (!mdLoaded) {
    try {
      const raw = fs.readFileSync(glossaryFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as { entries?: unknown };
      if (Array.isArray(parsed.entries)) {
        const clean = parsed.entries
          .map((e) => e as Record<string, unknown>)
          .filter((e) => typeof e.from === 'string' && (e.from as string).trim().length > 0)
          .map((e) => ({
            from: String(e.from),
            to: typeof e.to === 'string' ? e.to : '',
            mode: e.mode === 'phrase' ? 'phrase' : 'word',
          })) as GlossaryEntry[];
        if (clean.length > 0) entries = clean;
      }
    } catch {
      // нет файла/битый JSON — используем DEFAULT_GLOSSARY
    }
  }

  // Длинные ключи раньше — чтобы «болевые точки» сработало до «боли».
  entries = [...entries].sort((a, b) => b.from.length - a.from.length);
  cache = { at: now, entries };
  return entries;
}

/**
 * Добавляет/обновляет правило в md-глоссарии (создаёт файл при отсутствии) и
 * сбрасывает кэш — правило действует со следующей генерации без перезапуска.
 */
export function addGlossaryRule(from: string, to: string): GlossaryEntry[] {
  const cleanFrom = String(from ?? '').trim();
  const cleanTo = String(to ?? '').trim();
  if (!cleanFrom) throw new Error('Пустое слово для замены');

  const p = glossaryMdPath();
  let existing = '';
  try {
    existing = fs.readFileSync(p, 'utf8');
  } catch {
    existing =
      '# Глоссарий замен для протокола\n\n' +
      'Формат: `слово -> замена` (пустая замена — слово удаляется из текста).\n' +
      'Файл можно править руками; ИИ дополняет его по просьбе в чате.\n\n';
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }

  // Обновление существующего правила: убираем старую строку с тем же from.
  const withoutOld = existing
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*[-*]?\s*(.+?)\s*(?:->|=>|→)/);
      return !(m && m[1].trim().toLowerCase() === cleanFrom.toLowerCase());
    })
    .join('\n');

  const next = `${withoutOld.replace(/\n*$/, '\n')}- ${cleanFrom} -> ${cleanTo}\n`;
  fs.writeFileSync(p, next, 'utf8');
  cache = null; // применить немедленно
  return loadEntries();
}

/** Список правил глоссария (для промпта и инструмента). */
export function listGlossaryEntries(): GlossaryEntry[] {
  return loadEntries();
}

/**
 * Блок для системного промпта: модель видит запрещённые слова и сразу пишет
 * правильно (кодовая подстановка страхует на 100%, но не умеет склонять —
 * поэтому список даётся и модели).
 */
export function formatGlossaryForPrompt(): string {
  const entries = loadEntries();
  if (entries.length === 0) return '';
  const lines = entries.map((e) =>
    e.to ? `- «${e.from}» → пиши «${e.to}»` : `- «${e.from}» → не употребляй (опусти слово)`,
  );
  return (
    '\n\n### ГЛОССАРИЙ ЗАМЕН (обязателен, дополняет регламент)\n' +
    'Следующие слова и формулировки ЗАПРЕЩЕНЫ в тексте протокола — используй замену (в нужном падеже и числе):\n' +
    lines.join('\n')
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Сохраняет регистр первой буквы исходного слова в замене. */
function matchCase(source: string, replacement: string): string {
  if (!replacement) return replacement;
  const first = source.charAt(0);
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function applyEntry(text: string, entry: GlossaryEntry): string {
  const body = escapeRegex(entry.from);
  // Граница «слова» с учётом кириллицы: слева/справа не буква и не цифра.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${body})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, (m) => matchCase(m, entry.to));
}

/**
 * Латинские буквы-«близнецы» кириллических — модель иногда подставляет их
 * внутрь кириллического слова (визуально неотличимо: «ЭДO» с латинской O).
 * Карта только для букв, у которых написание совпадает 1-в-1.
 */
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
};

/**
 * Заменяет латинские буквы-гомоглифы на кириллические внутри слов, где
 * кириллических букв больше, чем латинских (значит слово по смыслу кириллическое,
 * а латиница в нём — опечатка модели). Слова целиком на латинице (Ozon, MVP, 1С)
 * не трогает — там кириллических букв нет вовсе, условие «больше» не выполняется.
 */
export function normalizeCyrillicHomoglyphs(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\p{L}+/gu, (word) => {
    let cyrCount = 0;
    let latCount = 0;
    for (const ch of word) {
      if (/[а-яёА-ЯЁ]/.test(ch)) cyrCount++;
      else if (/[a-zA-Z]/.test(ch)) latCount++;
    }
    if (cyrCount === 0 || latCount === 0 || cyrCount <= latCount) return word;
    let out = '';
    for (const ch of word) {
      out += CYRILLIC_HOMOGLYPHS[ch] ?? ch;
    }
    return out;
  });
}

/** Применяет словарь к произвольной строке. Пустые/нестроковые — без изменений. */
export function applyGlossary(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const entry of loadEntries()) {
    out = applyEntry(out, entry);
  }
  out = normalizeCyrillicHomoglyphs(out);
  // Подчистить двойные пробелы, появившиеся после удаления слов (to: '').
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1');
}

/**
 * Применяет словарь к содержательным полям протокола.
 * НЕ трогает ФИО участников/подписантов и названия организаций.
 */
export function applyGlossaryToProtocol(protocol: Protocol): Protocol {
  const g = applyGlossary;
  return {
    ...protocol,
    protocolTitle: g(protocol.protocolTitle),
    contractSubject:
      protocol.contractSubject !== undefined ? g(protocol.contractSubject) : protocol.contractSubject,
    agenda: { items: protocol.agenda.items.map((it) => g(it)) },
    meetingContent: {
      topics: protocol.meetingContent.topics.map((t) => ({
        ...t,
        title: g(t.title),
        // listened = только ФИО участников — не трогаем
        discussed: g(t.discussed),
        decided: g(t.decided),
      })),
      summary: protocol.meetingContent.summary.map((r) => ({
        question: g(r.question),
        decision: g(r.decision),
      })),
    },
  };
}
