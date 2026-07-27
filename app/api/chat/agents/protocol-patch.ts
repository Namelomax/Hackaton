/**
 * Точечная правка протокола.
 *
 * Полная перегенерация документа (streamObject по всей истории) переписывает и
 * те формулировки, которых правка не касалась: порядок ФИО, маркер «требует
 * уточнения» → «подлежит уточнению», «Заказчик (ФИО) сообщил» → «Заказчик
 * сообщил». Заказчику это видно как «протоколер испортил соседние места».
 *
 * Здесь модель не пишет документ заново, а возвращает СПИСОК ЗАМЕН
 * (find → replace) по текущему тексту. Замены применяются детерминированно к
 * строковым полям Protocol JSON, поэтому всё, что не затронуто, остаётся
 * байт в байт прежним. Если хоть одна замена неоднозначна — патч отменяется
 * целиком и вызывающий код уходит на полную генерацию.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { documentReasoningOptions, formatUsage } from '@/lib/reasoning-options';

export type ProtocolEdit = { find: string; replace: string };

const PatchPlanSchema = z.object({
  canPatch: z
    .boolean()
    .describe('true — правку можно выразить точечными заменами; false — нужна полная пересборка'),
  reason: z.string().max(300).default(''),
  edits: z
    .array(
      z.object({
        find: z.string().min(2).describe('точная подстрока из текущего протокола'),
        replace: z.string().describe('на что заменить (пустая строка = удалить)'),
        all: z
          .boolean()
          .default(false)
          .describe('true — заменить ВСЕ вхождения (одно и то же значение по всему протоколу)'),
      }),
    )
    .max(30)
    .default([]),
});

export type ProtocolPatchPlan = z.infer<typeof PatchPlanSchema>;

const PATCH_PLANNER_PROMPT = `Ты — редактор готового протокола обследования. Тебе дан ТЕКУЩИЙ текст протокола и сообщение пользователя с правкой.

Твоя задача — НЕ переписывать протокол, а вернуть минимальный список точечных замен.

ПРАВИЛА:
1. Каждый "find" — ТОЧНАЯ подстрока из текущего протокола, скопированная символ в символ: тот же регистр, тот же ПАДЕЖ, те же кавычки и пунктуация. Не приводи слова к именительному падежу — копируй как есть в тексте («от учреждения», а не «Учреждение»). Значок ⚠️ в "find" НЕ пиши: в тексте маркер выглядит как «требует уточнения» или «подлежит уточнению», значок добавляется только при показе.
1.1. "find" должен быть куском ТЕКСТА (предложение, фраза, значение поля), а не строкой разметки: не бери заголовки разделов, номера пунктов, шапки таблиц и символы «|».
2. Если правка означает ОДНО И ТО ЖЕ значение по всему документу (наименование учреждения, название чата или системы, ФИО, должность, номер договора) — поставь "all": true, и замена применится ко ВСЕМ вхождениям. Так и надо для «учреждение называется…», «чат называется…».
2.1. Если правка касается КОНКРЕТНОГО места (срок в одном пункте, решение по одному вопросу), оставь "all": false — тогда "find" обязан встречаться РОВНО ОДИН раз, добавь соседний текст для уникальности. Никогда не ставь "all": true для повторяющихся служебных фраз вроде «Срок: требует уточнения» — они относятся к разным пунктам.
3. Меняй ТОЛЬКО то, что прямо просит пользователь. Не улучшай стиль, не переставляй ФИО, не трогай соседние предложения.
4. Если пользователь уточняет то, что помечено «⚠️ требует уточнения» — заменяй именно маркер (вместе с пояснением в скобках, если оно есть) на конкретное значение.
5. Относительные даты («на следующей неделе», «в четверг») заменяй на конкретные ДД.ММ.ГГГГ, только если пользователь их назвал.
6. canPatch = false, если правка требует пересборки структуры: добавить/убрать участника, пункт повестки, раздел, переписать «Обсудили» целиком, поменять нумерацию. В этом случае edits оставь пустым.
7. Ничего не выдумывай: значений, которых нет в сообщении пользователя, в "replace" быть не должно.

Ответ — только JSON по схеме.

=== ТЕКУЩИЙ ПРОТОКОЛ ===
{{DOCUMENT}}

=== ПРАВКА ПОЛЬЗОВАТЕЛЯ ===
{{REQUEST}}`;

/** Спрашивает у модели план точечных замен. Ошибка LLM = «патчить нельзя». */
export async function planProtocolPatch(options: {
  model: any;
  documentMarkdown: string;
  userRequest: string;
  abortSignal?: AbortSignal;
}): Promise<ProtocolPatchPlan> {
  const { model, documentMarkdown, userRequest, abortSignal } = options;
  const prompt = PATCH_PLANNER_PROMPT.replace('{{DOCUMENT}}', documentMarkdown).replace(
    '{{REQUEST}}',
    userRequest,
  );

  try {
    const result = await generateObject({
      model,
      schema: PatchPlanSchema,
      prompt,
      temperature: 0,
      maxOutputTokens: 2048,
      // Планировщик замен — самая короткая задача во всём пайплайне; раньше он
      // единственный шёл БЕЗ отключения размышлений и поэтому мог думать
      // дольше, чем длится сама генерация протокола.
      providerOptions: documentReasoningOptions(),
      ...(abortSignal ? { abortSignal } : {}),
    });
    console.log(`[protocol-patch] план получен, ${formatUsage((result as any).usage)}`);
    return result.object;
  } catch (err) {
    console.warn('[protocol-patch] план замен не построен:', (err as Error)?.message ?? err);
    return { canPatch: false, reason: 'planner failed', edits: [] };
  }
}

/** Рекурсивно обходит строковые поля Protocol JSON. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapStrings(v, fn);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Поиск фрагмента без учёта регистра. Модель копирует текст неточно — реальный
 * промах на стенде: она вернула «Учреждение (наименование требует уточнения)»,
 * а в протоколе стояло «учреждение (…)» со строчной, и патч откатывался на
 * полную пересборку из-за одной буквы. Длина строки при toLowerCase для
 * кириллицы сохраняется, поэтому индексы остаются валидными для оригинала.
 */
function indexOfLoose(haystack: string, needle: string, from = 0): number {
  const exact = haystack.indexOf(needle, from);
  if (exact !== -1) return exact;
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}

function countOccurrences(protocol: Protocol, find: string): number {
  let total = 0;
  mapStrings(protocol, (s) => {
    let idx = indexOfLoose(s, find);
    while (idx !== -1) {
      total += 1;
      idx = indexOfLoose(s, find, idx + find.length);
    }
    return s;
  });
  return total;
}

export type ApplyEditsResult =
  | { ok: true; protocol: Protocol; applied: ProtocolEdit[]; warnings: string[] }
  | { ok: false; reason: string; failedEdit?: ProtocolEdit };

/**
 * Применяет замены к строковым полям протокола.
 *
 * Принцип «что смог — применил, о чём не смог — сказал». Раньше любая осечка
 * отменяла патч целиком и уводила на полную пересборку, а та переписывала треть
 * документа и всё равно обновляла не все места. Теперь каждая замена живёт
 * своей жизнью: не нашлась — пропускаем её и пишем предупреждение, остальные
 * применяются. На полную генерацию уходим, только если не применилось НИЧЕГО.
 */
export function applyEditsToProtocol(
  protocol: Protocol,
  edits: ProtocolEdit[],
): ApplyEditsResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, reason: 'пустой список замен' };
  }

  let current = protocol;
  const applied: ProtocolEdit[] = [];
  const warnings: string[] = [];

  for (const edit of edits) {
    let find = String(edit?.find ?? '');
    const replace = String(edit?.replace ?? '');
    if (!find.trim()) continue;
    if (find === replace) continue;

    // В полях Protocol JSON значка ⚠️ нет — он навешивается при отрисовке
    // markdown. Модель всё равно копирует его из текста, поэтому подстраховываемся:
    // не нашли как есть — ищем очищенный вариант.
    if (countOccurrences(current, find) === 0) {
      const normalized = find.replace(/⚠️/g, '').replace(/\s{2,}/g, ' ').trim();
      if (normalized && normalized !== find && countOccurrences(current, normalized) > 0) {
        find = normalized;
      }
    }

    // Модель нередко ставит первое слово в другом падеже: на стенде она дала
    // «Учреждение (наименование требует уточнения)», а в тексте стояло
    // «учреждения (…)». Отбрасываем ведущие слова, пока остаток не найдётся
    // ровно один раз и остаётся достаточно длинным, чтобы не зацепить лишнее.
    if (countOccurrences(current, find) === 0) {
      const words = find.split(/\s+/);
      for (let drop = 1; drop <= 2 && drop < words.length; drop++) {
        const tail = words.slice(drop).join(' ');
        if (tail.length < 12) break;
        if (countOccurrences(current, tail) === 1) {
          console.log(
            `[protocol-patch] фрагмент найден без первых ${drop} слов (падеж не совпал): "${tail.slice(0, 60)}"`,
          );
          find = tail;
          break;
        }
      }
    }

    let replaceAll = Boolean((edit as any)?.all);
    const occurrences = countOccurrences(current, find);
    if (occurrences === 0) {
      warnings.push(`не нашёл в протоколе фрагмент «${find.slice(0, 70)}» — проверьте это место вручную`);
      console.log(`[protocol-patch] пропуск замены: фрагмент не найден — "${find.slice(0, 60)}"`);
      continue;
    }
    // Одно значение на весь документ (название чата, учреждения, ФИО) — меняем
    // везде. Реальный случай со стенда: «наименование требует уточнения»
    // встречалось 6 раз, патч откатывался, и полная пересборка обновляла лишь
    // часть мест — в резюме оставалось старое.
    //
    // Если модель не проставила флаг, но фрагмент — явная «дырка» (маркер
    // уточнения или «не указано»), одно и то же значение подходит везде:
    // считаем такую замену глобальной сами. Сроки сюда не попадают — у них
    // в тексте стоит «Срок:», и это разные пункты.
    if (occurrences > 1 && !replaceAll) {
      const looksLikeBlank =
        /(?:наименовани|названи|требует уточнени|подлежит уточнени|не указан)/i.test(find) &&
        !/срок/i.test(find);
      if (looksLikeBlank) {
        replaceAll = true;
        console.log(
          `[protocol-patch] фрагмент встречается ${occurrences} раз и выглядит как незаполненное место — меняю везде`,
        );
      } else {
        warnings.push(
          `фрагмент «${find.slice(0, 60)}» встречается ${occurrences} раз — заменил только первое вхождение, проверьте остальные`,
        );
        console.log(`[protocol-patch] неоднозначный фрагмент (${occurrences}) — меняю первое вхождение`);
      }
    }

    let done = false;
    current = mapStrings(current, (s) => {
      if (done && !replaceAll) return s;
      let out = s;
      let idx = indexOfLoose(out, find);
      while (idx !== -1) {
        out = out.slice(0, idx) + replace + out.slice(idx + find.length);
        done = true;
        if (!replaceAll) break;
        idx = indexOfLoose(out, find, idx + replace.length);
      }
      return out;
    });
    applied.push({ find, replace });
    if (replaceAll && occurrences > 1) {
      console.log(`[protocol-patch] замена применена во всех ${occurrences} местах: "${find.slice(0, 50)}"`);
    }
  }

  if (applied.length === 0) {
    return { ok: false, reason: 'ни одна замена не подошла' };
  }
  return { ok: true, protocol: current, applied, warnings };
}

/** Анонимизация всех строковых полей протокола (для отправки в облако). */
export function mapProtocolStrings(protocol: Protocol, fn: (s: string) => string): Protocol {
  return mapStrings(protocol, fn);
}
