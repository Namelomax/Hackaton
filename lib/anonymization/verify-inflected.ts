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
 *
 * ПОЧЕМУ generateText, А НЕ generateObject. Изначально вердикт брался через
 * `generateObject` со схемой zod. На стенде это молча не работало: локальная
 * модель (gemma-4-31b) не умеет structured output — тот же корень, что у
 * утечки псевдо-tool-call. `generateObject` бросал исключение, мы возвращали
 * null, и склейка падала в осторожный фолбэк, который частичные упоминания не
 * склеивает. Результат: «Сергея» оставался отдельным плейсхолдером от «Ковалёв
 * Сергей Андреевич», и облачная модель писала про «внешний контакт».
 * Простой построчный формат слабая модель осиливает.
 */
import { generateText } from 'ai';
import type { InflectionCandidate } from './merge-inflected';

/** Ответ модели: одна строка на пару, «<номер>: да|нет». */
function parseVerdictLines(
  text: string,
  asked: InflectionCandidate[],
): Record<string, boolean> {
  const verdict: Record<string, boolean> = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/(\d+)\s*[:.)-]\s*(да|нет|yes|no|true|false)/i);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= asked.length) continue;
    verdict[asked[idx].drop] = /^(да|yes|true)$/i.test(m[2]);
  }
  return verdict;
}

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
    .map((c, i) => `${i + 1}. «${c.dropValue}»  и  «${c.keepValue}»`)
    .join('\n');

  const prompt = `Ниже пронумерованы пары обозначений из одного документа. Для каждой пары ответь, это ОДИН И ТОТ ЖЕ человек (или одна и та же организация) — просто записанный в другом падеже, сокращённо или только по имени, — или РАЗНЫЕ объекты.

Правила:
- «Ирины Соколовой» и «Ирина Соколова» — один человек (родительный падеж) → да
- «Сергея» и «Ковалёв Сергей Андреевич» — один человек (назван только по имени) → да
- «Никита» и «Грицанюк Никита Сергеевич» — один человек → да
- «Форуса» и «Форус» — одна организация → да
- «Иванов» и «Иванова» — могут быть разные люди (мужчина и женщина) → нет, если нет уверенности
- «Иванов Пётр» и «Иванова Мария» — разные люди → нет

ОТВЕТ: строго по одной строке на пару, в формате «номер: да» или «номер: нет». Ничего больше не пиши.

ПАРЫ:
${list}`;

  try {
    const { text } = await generateText({
      model,
      prompt,
      temperature: 0,
      maxOutputTokens: 200,
      ...(abortSignal ? { abortSignal } : {}),
    });
    const parsed = parseVerdictLines(text, asked);
    // Модель не ответила ни по одной паре — считаем, что вердикта нет, и пусть
    // решает осторожный фолбэк. Иначе пустой ответ читался бы как «все разные».
    if (Object.keys(parsed).length === 0) {
      console.warn('[anon-merge] модель вернула ответ без вердиктов:', String(text).slice(0, 120));
      return null;
    }
    return { ...verdict, ...parsed };
  } catch (err) {
    console.warn('[anon-merge] модель не оценила пары:', (err as Error)?.message);
    return null;
  }
}

export { parseVerdictLines as __parseVerdictLinesForTests };
