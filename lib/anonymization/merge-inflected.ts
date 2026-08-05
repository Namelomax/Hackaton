/**
 * Склейка плейсхолдеров, разошедшихся из-за падежей.
 *
 * Анонимизатор обрабатывает каждое сообщение отдельно и не знает, что
 * «Ирины Соколовой» из правки — это та же [PERSON_1] «Ирина Соколова» из
 * расшифровки. В результате заводится новый плейсхолдер, облачная модель видит
 * ДВУХ разных людей и честно отвечает «Ирины Соколовой в расшифровке нет».
 *
 * Русские падежи меняют окончания, поэтому сравнение строк «в лоб» не работает.
 * Здесь два шага: дешёвое сопоставление по основам слов отбирает КАНДИДАТОВ, а
 * решение по каждой спорной паре принимает модель — она понимает, «Соколовой» и
 * «Соколова» это один человек или два разных.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { Mapping } from './types';

/**
 * Основа слова для грубого сопоставления.
 *
 * Срезать «окончание по списку» не годится: у «Сергей» жадно отрывается «ей»,
 * а у «Сергея» только «я» — основы расходятся, и пара не находится вовсе.
 * Берём начало слова: падежи меняют хвост, начало остаётся. Четырёх букв
 * достаточно, чтобы «Ирина/Ирины», «Соколова/Соколовой», «Сергей/Сергея»
 * совпали; лишние совпадения («Иванов/Иванова») отсеет модель.
 */
function stem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/gu, '');
  return w.length <= 4 ? w : w.slice(0, 4);
}

/** Ключ сравнения: набор основ слов без порядка («Соколова Ирина» = «Ирина Соколовой»). */
function stemKey(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map(stem)
    .filter((s) => s.length >= 2)
    .sort()
    .join(' ');
}

function labelOf(placeholder: string): string {
  const m = placeholder.match(/^\[([A-Z]+)_\d+\]$/);
  return m ? m[1] : '';
}

export type InflectionCandidate = { keep: string; drop: string; keepValue: string; dropValue: string };

/** Пары «новый плейсхолдер — вероятно, тот же объект, что уже есть». */
export function findInflectedCandidates(mapping: Mapping): InflectionCandidate[] {
  const entries = Object.entries(mapping);
  const byKey = new Map<string, { ph: string; value: string }[]>();

  for (const [ph, value] of entries) {
    const label = labelOf(ph);
    // Склеиваем только то, где падежи реальны: люди и организации.
    if (label !== 'PERSON' && label !== 'ORG') continue;
    const key = `${label}:${stemKey(String(value))}`;
    if (!key.endsWith(':')) {
      const list = byKey.get(key) ?? [];
      list.push({ ph, value: String(value) });
      byKey.set(key, list);
    }
  }

  const out: InflectionCandidate[] = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    // Оставляем тот плейсхолдер, что появился раньше (меньший номер).
    const sorted = [...list].sort(
      (a, b) => (Number(a.ph.match(/_(\d+)\]/)?.[1] ?? 0) - Number(b.ph.match(/_(\d+)\]/)?.[1] ?? 0)),
    );
    const keep = sorted[0];
    for (const dup of sorted.slice(1)) {
      if (dup.value === keep.value) {
        // Полное совпадение значения — падежей нет, решать нечего.
        out.push({ keep: keep.ph, drop: dup.ph, keepValue: keep.value, dropValue: dup.value });
        continue;
      }
      out.push({ keep: keep.ph, drop: dup.ph, keepValue: keep.value, dropValue: dup.value });
    }
  }
  return out;
}

const VerdictSchema = z.object({
  pairs: z
    .array(
      z.object({
        drop: z.string().describe('плейсхолдер-дубль из списка'),
        same: z.boolean().describe('true — это тот же человек/организация в другом падеже'),
      }),
    )
    .default([]),
});

/**
 * Спрашивает модель, какие пары действительно одно и то же.
 * Ошибка/недоступность — возвращает null, тогда решает вызывающий код.
 */
export async function verifyInflectedPairs(options: {
  model: any;
  candidates: InflectionCandidate[];
  abortSignal?: AbortSignal;
}): Promise<Record<string, boolean> | null> {
  const { model, candidates, abortSignal } = options;
  if (candidates.length === 0) return {};

  const list = candidates
    .map((c, i) => `${i + 1}. ${c.drop} = «${c.dropValue}»  ↔  ${c.keep} = «${c.keepValue}»`)
    .join('\n');

  const prompt = `Ниже пары обозначений из одного документа. В каждой паре проверь: это ОДИН И ТОТ ЖЕ человек (или одна и та же организация), просто записанный в другом падеже или в другой форме, — или это РАЗНЫЕ объекты.

Учитывай русскую морфологию: «Ирины Соколовой» и «Ирина Соколова» — один человек; «Сергея» и «Сергей» — один; «Иванов» и «Иванова» — могут быть РАЗНЫЕ люди (мужчина и женщина), тут отвечай false, если нет уверенности.

Для каждой пары верни drop (обозначение из левой части) и same.

ПАРЫ:
${list}`;

  try {
    const result = await generateObject({
      model,
      schema: VerdictSchema,
      prompt,
      temperature: 0,
      maxOutputTokens: 512,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const verdict: Record<string, boolean> = {};
    for (const p of result.object.pairs) verdict[String(p.drop)] = Boolean(p.same);
    return verdict;
  } catch (err) {
    console.warn('[anon-merge] модель не оценила пары:', (err as Error)?.message);
    return null;
  }
}

/**
 * Применяет решение: дубли выбрасываются из mapping, а их значения
 * возвращаются как алиасы к оставшемуся плейсхолдеру.
 * Алиасы нужны для прямой подстановки: встретили «Ирины Соколовой» — пишем
 * тот же [PERSON_1].
 */
export function applyInflectionMerge(
  mapping: Mapping,
  candidates: InflectionCandidate[],
  verdict: Record<string, boolean> | null,
): { mapping: Mapping; aliases: Array<{ value: string; placeholder: string }>; merged: string[] } {
  const next: Mapping = { ...mapping };
  const aliases: Array<{ value: string; placeholder: string }> = [];
  const merged: string[] = [];

  for (const c of candidates) {
    // Нет вердикта модели — склеиваем только полные совпадения значений.
    const same = verdict ? verdict[c.drop] === true : c.dropValue === c.keepValue;
    if (!same) continue;
    delete next[c.drop];
    aliases.push({ value: c.dropValue, placeholder: c.keep });
    merged.push(`${c.drop} («${c.dropValue}») → ${c.keep} («${c.keepValue}»)`);
  }

  return { mapping: next, aliases, merged };
}
