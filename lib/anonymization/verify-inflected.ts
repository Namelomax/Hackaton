/**
 * Арбитр спорных падежных пар.
 *
 * Отбор кандидатов (`merge-inflected.ts`) намеренно строгий по форме слова, но
 * форма не отвечает на вопрос «Иванов и Иванова — это один человек или двое».
 * Отвечает модель. Живёт отдельным файлом, чтобы `import 'ai'` не тянулся в
 * чистую строковую логику и в её тесты.
 *
 * ВАЖНО: модель тут ЛОКАЛЬНАЯ (ollama). В режиме анонимизации ПДн ещё не
 * замаскированы — отправлять пары в облако нельзя.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import type { InflectionCandidate } from './merge-inflected';

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
  // Побуквенно совпавшие значения модели показывать незачем.
  const asked = candidates.filter((c) => !c.identical);
  const verdict: Record<string, boolean> = {};
  for (const c of candidates) if (c.identical) verdict[c.drop] = true;
  if (asked.length === 0) return verdict;

  const list = asked
    .map((c, i) => `${i + 1}. ${c.drop} = «${c.dropValue}»  ↔  ${c.keep} = «${c.keepValue}»`)
    .join('\n');

  const prompt = `Ниже пары обозначений из одного документа. В каждой паре проверь: это ОДИН И ТОТ ЖЕ человек (или одна и та же организация), просто записанный в другом падеже, сокращённо или в другой форме, — или это РАЗНЫЕ объекты.

Учитывай русскую морфологию:
- «Ирины Соколовой» и «Ирина Соколова» — один человек (родительный падеж);
- «Сергея» и «Сергей» — один;
- «Ирину» и «Ирина Соколова» — один человек (упомянут только по имени);
- «Форуса» и «Форус» — одна организация;
- «Иванов» и «Иванова» — могут быть РАЗНЫЕ люди (мужчина и женщина), тут отвечай false, если нет уверенности;
- «Иванов Пётр» и «Иванова Мария» — разные люди.

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
      providerOptions: { openrouter: { reasoning: { enabled: false, exclude: true } } },
      ...(abortSignal ? { abortSignal } : {}),
    });
    for (const p of result.object.pairs) verdict[String(p.drop)] = Boolean(p.same);
    return verdict;
  } catch (err) {
    console.warn('[anon-merge] модель не оценила пары:', (err as Error)?.message);
    return null;
  }
}
