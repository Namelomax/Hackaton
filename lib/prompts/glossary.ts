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

function loadEntries(): GlossaryEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < GLOSSARY_TTL_MS) return cache.entries;

  let entries: GlossaryEntry[] = DEFAULT_GLOSSARY;
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

  // Длинные ключи раньше — чтобы «болевые точки» сработало до «боли».
  entries = [...entries].sort((a, b) => b.from.length - a.from.length);
  cache = { at: now, entries };
  return entries;
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

/** Применяет словарь к произвольной строке. Пустые/нестроковые — без изменений. */
export function applyGlossary(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const entry of loadEntries()) {
    out = applyEntry(out, entry);
  }
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
