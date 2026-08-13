/**
 * Склейка плейсхолдеров, разошедшихся из-за падежей.
 *
 * Анонимизатор обрабатывает каждое сообщение отдельно и не знает, что
 * «Ирины Соколовой» из правки — это та же [PERSON_1] «Ирина Соколова» из
 * расшифровки. В результате заводится новый плейсхолдер, облачная модель видит
 * ДВУХ разных людей и честно отвечает «Ирины Соколовой в расшифровке нет».
 *
 * Русские падежи меняют окончания, поэтому сравнение строк «в лоб» не работает.
 * Здесь три шага:
 *   1. дешёвый отбор по первым буквам слова (падежи хвост меняют, начало — нет);
 *   2. ЖЁСТКАЯ проверка формы слова (`sameWordShape`) — отсекает «Александра» и
 *      «Алексея», у которых совпадает только «алекс»;
 *   3. решение по каждой спорной паре принимает модель — она понимает,
 *      «Соколовой» и «Соколова» это один человек или два разных.
 *
 * Итог склейки — не только вычищенный mapping, но и АЛИАСЫ
 * («Ирины Соколовой» → [PERSON_1]). Алиасы сохраняются в диалоге, поэтому
 * склонённая форма проверяется моделью ОДИН раз, а дальше подставляется
 * детерминированно.
 *
 * Модуль намеренно ЧИСТЫЙ: сам вызов модели живёт в `verify-inflected.ts`.
 * Иначе `import 'ai'` тянется в каждый импортёр (включая тесты и серверные
 * утилиты), а вся логика здесь — строки и словари.
 */

import type { Mapping, PlaceholderAlias } from './types';

/**
 * Падежные окончания русского языка, длинные первыми — чтобы у «ами» снялось
 * «ами», а не «и». Таблица продублирована из `canonicalize.ts` СОЗНАТЕЛЬНО:
 * тот модуль не входит в сборку сервера, и импорт из него ронял `next build`
 * («Can't resolve ./canonicalize»). Двадцать строк дубля дешевле, чем связь
 * между модулями с разной судьбой.
 */
const DECL_SUFFIXES = [
  'иями', 'иях', 'ами', 'ями', 'ах', 'ях', 'ом', 'ем', 'ём', 'ой', 'ей',
  'им', 'ым', 'у', 'ю', 'е', 'и', 'ы', 'а', 'я',
].sort((a, b) => b.length - a.length);

/** Ниже трёх символов основы не режем: короткие основы начинают слипаться. */
const MIN_STEM = 3;

/** Основа слова: снимаем известное падежное окончание, если основа переживёт. */
function wordStem(word: string): string {
  for (const suf of DECL_SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= MIN_STEM) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

/**
 * Метки, у которых падежи реальны и склейка осмысленна.
 *
 * LOCATION добавлен по итогам стенда: NER регулярно принимает голое имя за
 * место — «Никита» приехал как [LOCATION_1] при том, что «Грицанюк Никита
 * Сергеевич» уже был [PERSON_2]. Пока метки сравнивались строго, такая пара
 * даже не попадала в кандидаты, и облачная модель видела лишнюю сущность.
 */
const MERGEABLE_LABELS = new Set(['PERSON', 'ORG', 'LOCATION']);

/**
 * Приоритет метки при выборе «главного» плейсхолдера группы. Человек всегда
 * важнее организации и места: если одна и та же строка приехала и как PERSON,
 * и как LOCATION, каноничной должна остаться персона. Номера плейсхолдеров
 * считаются ОТДЕЛЬНО по каждой метке, поэтому сравнивать [LOCATION_1] и
 * [PERSON_2] по числу бессмысленно.
 */
const LABEL_RANK: Record<string, number> = { PERSON: 0, ORG: 1, LOCATION: 2 };

/**
 * Можно ли вообще сравнивать значения с такими метками.
 *
 * Разные метки допускаем только там, где детектор реально путается:
 *   • PERSON ↔ LOCATION/ORG — когда не-персона состоит из ОДНОГО слова
 *     (голое имя, принятое за место или контору);
 *   • ORG ↔ LOCATION — классическая пара («Телеграм» то организация, то место).
 * Пару «PERSON из трёх слов» и «ORG из трёх слов» не сводим никогда.
 */
function labelsCompatible(a: Entry, b: Entry): boolean {
  if (a.label === b.label) return true;
  const [person, other] = a.label === 'PERSON' ? [a, b] : b.label === 'PERSON' ? [b, a] : [null, null];
  if (person && other) return other.parts.length === 1;
  return (
    (a.label === 'ORG' && b.label === 'LOCATION') || (a.label === 'LOCATION' && b.label === 'ORG')
  );
}

/** Длина «корзины» для дешёвого отбора кандидатов. */
const BUCKET_LEN = 3;

/** Нормализация слова: регистр, ё→е, прочь пунктуация и дефисы. */
function normWord(word: string): string {
  return word.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/gu, '');
}

/** Значимые слова значения (инициалы «И.» и частицы отсекаются длиной). */
function words(value: string): string[] {
  return String(value)
    .trim()
    .split(/\s+/)
    .map(normWord)
    .filter((w) => w.length >= 2);
}

/**
 * Буквы, из которых состоят русские окончания. Согласная в «хвосте» означает,
 * что перед нами другая основа, а не другой падеж: «мари|» vs «марин|»
 * («Мария» и «Марина» — разные люди), «петр|» vs «петр|ов».
 */
const ENDING_CHARS = new Set('аеёиоуыэюяйь');

/**
 * Одно ли это слово в разных падежах.
 *
 * Раньше здесь было «первые 4 буквы совпали» — и «Александр» с «Алексеем»
 * попадали в одну корзину («алек»), а при недоступной модели фолбэк склеивал
 * их в одного человека.
 *
 * Теперь сначала снимаем известное падежное окончание (`wordStem`, общая
 * таблица с canonicalize.ts). Если основы совпали — это одно слово. Если одна
 * основа оказалась началом другой, допускаем расхождение до двух символов, но
 * ТОЛЬКО из «окончательных» букв: у «Сергей» жадно срезается «ей» (→ «серг»),
 * а у «Сергея» лишь «я» (→ «серге»), и без этой поблажки пара не нашлась бы.
 *
 *   ирина / ириной      → ирин  / ирин          одна словоформа
 *   соколова/соколовой  → соколов / соколов     одна словоформа
 *   сергей / сергея     → серг / серге («е»)    одна словоформа
 *   александр / алексей → александр / алекс     РАЗНЫЕ (хвост «андр»)
 *   мария / марина      → мари / марин («н»)    РАЗНЫЕ
 *   петр / петров       → петр / петров («ов»)  РАЗНЫЕ
 */
export function sameWordShape(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;

  const sa = wordStem(normWord(a));
  const sb = wordStem(normWord(b));
  if (sa === sb) return sa.length >= 3;

  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length < 3) return false;
  if (!long.startsWith(short)) return false;

  const tail = long.slice(short.length);
  if (tail.length === 0 || tail.length > 2) return false;
  return [...tail].every((ch) => ENDING_CHARS.has(ch));
}

type Entry = {
  ph: string;
  label: string;
  value: string;
  parts: string[];
  num: number;
};

/** `[PERSON_1]` → `PERSON`; `[MILITARY_ID_1]` → `MILITARY_ID`. */
function labelOf(placeholder: string): string {
  const m = placeholder.match(/^\[([A-Z][A-Z_]*)_(\d+)\]$/);
  return m ? m[1] : '';
}

function numOf(placeholder: string): number {
  const m = placeholder.match(/_(\d+)\]$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Сопоставление двух значений пословно (порядок не важен: «Соколова Ирина» =
 * «Ирина Соколовой»). Возвращает null, если это заведомо разные объекты.
 *
 * `partial: true` — одно значение является ЧАСТЬЮ другого: «Ирину» ↔
 * «Ирина Соколова». Такое встречается в правках («убери Ирину из списка») и
 * тоже должно склеиваться, но решение по нему всегда за моделью.
 */
function matchValues(a: string[], b: string[]): { partial: boolean } | null {
  if (a.length === 0 || b.length === 0) return null;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Array<boolean>(big.length).fill(false);

  for (const w of small) {
    const idx = big.findIndex((cand, i) => !used[i] && sameWordShape(w, cand));
    if (idx === -1) return null; // слово из короткого значения не нашлось — разные объекты
    used[idx] = true;
  }
  return { partial: small.length !== big.length };
}

export type InflectionCandidate = {
  keep: string;
  drop: string;
  keepValue: string;
  dropValue: string;
  /** Значения совпали полностью (падежей нет) — решать нечего. */
  identical: boolean;
  /** Одно значение — часть другого («Ирину» ↔ «Ирина Соколова»). */
  partial: boolean;
  /** Метки разошлись («Никита» как LOCATION против PERSON) — решает модель. */
  crossLabel: boolean;
  /** Число слов в более коротком из двух значений. */
  wordCount: number;
  label: string;
};

/**
 * Пары «новый плейсхолдер — вероятно, тот же объект, что уже есть».
 *
 * Идём по возрастанию номера плейсхолдера и каждое значение сравниваем с уже
 * принятыми представителями. Так «Ирина Соколова» [PERSON_1], «Ирины
 * Соколовой» [PERSON_7] и «Ирину» [PERSON_9] сойдутся к одному [PERSON_1],
 * а не разобьются на две пары.
 */
export function findInflectedCandidates(mapping: Mapping): InflectionCandidate[] {
  const entries: Entry[] = [];
  for (const [ph, raw] of Object.entries(mapping ?? {})) {
    const label = labelOf(ph);
    if (!MERGEABLE_LABELS.has(label)) continue;
    const value = String(raw ?? '');
    const parts = words(value);
    if (parts.length === 0) continue;
    entries.push({ ph, label, value, parts, num: numOf(ph) });
  }
  // Сначала персоны, потом организации, потом места; внутри метки — по номеру.
  // Так «главным» в группе всегда оказывается самое содержательное значение.
  entries.sort(
    (a, b) => (LABEL_RANK[a.label] ?? 9) - (LABEL_RANK[b.label] ?? 9) || a.num - b.num,
  );

  // Дешёвый отбор: у одинаковых словоформ совпадает начало хотя бы одного слова.
  // Метку в ключ НЕ кладём — иначе «Никита» как LOCATION никогда не встретится
  // с «Грицанюк Никита Сергеевич» как PERSON. Совместимость меток проверяется
  // отдельно, в labelsCompatible.
  const buckets = new Map<string, Entry[]>();
  const bucketKeys = (e: Entry) => [...new Set(e.parts.map((w) => w.slice(0, BUCKET_LEN)))];

  const out: InflectionCandidate[] = [];

  for (const e of entries) {
    const seen = new Set<string>();
    let matched: { rep: Entry; partial: boolean } | null = null;

    for (const key of bucketKeys(e)) {
      for (const rep of buckets.get(key) ?? []) {
        if (seen.has(rep.ph)) continue;
        seen.add(rep.ph);
        if (!labelsCompatible(e, rep)) continue;
        const m = matchValues(e.parts, rep.parts);
        if (m) {
          matched = { rep, partial: m.partial };
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      out.push({
        keep: matched.rep.ph,
        drop: e.ph,
        keepValue: matched.rep.value,
        dropValue: e.value,
        identical: e.parts.join(' ') === matched.rep.parts.join(' '),
        partial: matched.partial,
        crossLabel: e.label !== matched.rep.label,
        wordCount: Math.min(e.parts.length, matched.rep.parts.length),
        label: e.label,
      });
      continue;
    }

    // Новый объект — становится представителем своей группы.
    for (const key of bucketKeys(e)) {
      const list = buckets.get(key) ?? [];
      list.push(e);
      buckets.set(key, list);
    }
  }

  return out;
}

/**
 * Решение без модели — намеренно осторожное.
 *
 * Склеиваем только то, где ошибка практически исключена:
 *   • значения совпали побуквенно;
 *   • полное совпадение по всем словам, слов >= 2 («Ирина Соколова» / «Ирины
 *     Соколовой»): чтобы случайно слиться, двум разным людям нужно совпасть
 *     формой И имени, И фамилии;
 *   • организация из одного слова («Форус» / «Форуса»): двух разных ORG,
 *     различающихся одним окончанием, на практике не бывает.
 *
 * НЕ склеиваем без модели: одиночные PERSON («Иванов» / «Иванова» — разный пол),
 * частичные упоминания («Ирину» ↔ «Ирина Соколова» — вдруг вторая Ирина) и всё,
 * где разошлись метки («Никита» как LOCATION против PERSON).
 */
function heuristicSame(c: InflectionCandidate): boolean {
  if (c.identical && !c.crossLabel) return true;
  if (c.crossLabel) return false;
  if (c.partial) return false;
  if (c.wordCount >= 2) return true;
  return c.label === 'ORG';
}

/** Окончания, характерные для ИМЕНИТЕЛЬНОГО падежа ФИО. */
const NOMINATIVE_PATTERNS = [
  /(ов|ев|ёв|ин|ын|ский|цкий|ская|цкая|ова|ева|ёва|ина|ына)$/i, // фамилия
  /(ович|евич|ьич|овна|евна|ична|инична)$/i,                    // отчество
];

/** Окончания, характерные для косвенных падежей. */
const OBLIQUE_PATTERNS = [
  /(овича|евича|овичу|евичу|овичем|евичем|овиче|евиче)$/i,
  /(овны|евны|овну|евну|овной|евной|овне|евне)$/i,
  /(ова|ева)го$/i,
];

/**
 * Насколько значение похоже на именительный падеж. Больше — лучше.
 *
 * Нужно, чтобы в документе фамилии стояли в именительном. Плейсхолдеру
 * достаётся та форма, которую детектор увидел ПЕРВОЙ, и если человека сначала
 * упомянули вскользь («добавь Петрова Алексея Ивановича»), то именно родительный
 * падеж и уезжал в таблицу участников. Идентификатор плейсхолдера при этом
 * менять нельзя — меняем только хранимое значение.
 */
export function nominativeScore(value: string): number {
  let score = 0;
  for (const word of String(value ?? '').split(/\s+/)) {
    const w = word.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z]/gu, '');
    if (w.length < 3) continue;
    if (OBLIQUE_PATTERNS.some((rx) => rx.test(w))) score -= 1;
    else if (NOMINATIVE_PATTERNS.some((rx) => rx.test(w))) score += 1;
  }
  return score;
}

/**
 * Применяет решение: дубли выбрасываются из mapping, а их значения
 * возвращаются как алиасы к оставшемуся плейсхолдеру.
 * Алиасы нужны для прямой подстановки: встретили «Ирины Соколовой» — пишем
 * тот же [PERSON_1].
 *
 * Заодно «повышаем» хранимое значение до именительного падежа, если склеиваемая
 * форма выглядит каноничнее — номер плейсхолдера остаётся прежним, а прежнее
 * значение уходит в алиасы.
 */
export function applyInflectionMerge(
  mapping: Mapping,
  candidates: InflectionCandidate[],
  verdict: Record<string, boolean> | null,
): { mapping: Mapping; aliases: PlaceholderAlias[]; merged: string[] } {
  const next: Mapping = { ...mapping };
  const aliases: PlaceholderAlias[] = [];
  const merged: string[] = [];
  // Цепочка [PERSON_9]→[PERSON_7]→[PERSON_1] должна схлопнуться в [PERSON_1].
  const redirect = new Map<string, string>();
  const resolve = (ph: string): string => {
    let cur = ph;
    for (let i = 0; i < 10 && redirect.has(cur); i++) cur = redirect.get(cur) as string;
    return cur;
  };

  for (const c of candidates) {
    const same =
      verdict && c.drop in verdict ? verdict[c.drop] === true : heuristicSame(c);
    if (!same) continue;
    if (!verdict || !(c.drop in verdict)) {
      console.log(
        `[anon-merge] вердикт модели не получен — склеиваю по форме слова: «${c.dropValue}» = «${c.keepValue}»`,
      );
    }
    const keep = resolve(c.keep);
    if (keep === c.drop) continue;
    delete next[c.drop];
    redirect.set(c.drop, keep);

    const keepValue = String(next[keep] ?? c.keepValue).trim();
    const dropValue = c.dropValue.trim();
    // Приезжающая форма каноничнее — она и становится значением плейсхолдера,
    // а прежняя уходит в алиасы. Подставляться будут обе, но в документ пойдёт
    // именительный падеж.
    if (dropValue && keepValue && nominativeScore(dropValue) > nominativeScore(keepValue)) {
      next[keep] = dropValue;
      aliases.push({ value: keepValue, placeholder: keep });
      merged.push(`${c.drop} («${dropValue}») → ${keep}, значение уточнено с «${keepValue}»`);
      continue;
    }

    if (dropValue) aliases.push({ value: dropValue, placeholder: keep });
    merged.push(`${c.drop} («${dropValue}») → ${keep} («${next[keep] ?? c.keepValue}»)`);
  }

  return { mapping: next, aliases, merged };
}

/**
 * Слить новые алиасы с сохранёнными: без дублей, длинные значения первыми
 * (чтобы «Ирины Соколовой» сработало раньше, чем «Ирины»).
 * Алиасы, чей плейсхолдер исчез из mapping, выбрасываются.
 */
export function mergeAliases(
  stored: PlaceholderAlias[] | undefined,
  fresh: PlaceholderAlias[],
  mapping: Mapping,
): PlaceholderAlias[] {
  const byValue = new Map<string, PlaceholderAlias>();
  for (const a of [...(stored ?? []), ...fresh]) {
    const value = String(a?.value ?? '').trim();
    const placeholder = String(a?.placeholder ?? '');
    if (!value || !placeholder) continue;
    // Значение, которое уже есть в mapping как оригинал, алиасом быть не должно.
    if (!Object.prototype.hasOwnProperty.call(mapping, placeholder)) continue;
    byValue.set(value, { value, placeholder });
  }
  return [...byValue.values()].sort((a, b) => b.value.length - a.value.length);
}
