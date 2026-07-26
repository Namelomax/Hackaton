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
      }),
    )
    .max(30)
    .default([]),
});

export type ProtocolPatchPlan = z.infer<typeof PatchPlanSchema>;

const PATCH_PLANNER_PROMPT = `Ты — редактор готового протокола обследования. Тебе дан ТЕКУЩИЙ текст протокола и сообщение пользователя с правкой.

Твоя задача — НЕ переписывать протокол, а вернуть минимальный список точечных замен.

ПРАВИЛА:
1. Каждый "find" — ТОЧНАЯ подстрока из текущего протокола, скопированная символ в символ (включая маркеры «⚠️ требует уточнения», кавычки и пунктуацию).
2. Каждый "find" обязан встречаться в протоколе РОВНО ОДИН раз. Если нужная фраза повторяется — добавь в "find" соседний текст, чтобы получилась уникальная строка.
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
      ...(abortSignal ? { abortSignal } : {}),
    });
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

function countOccurrences(protocol: Protocol, find: string): number {
  let total = 0;
  mapStrings(protocol, (s) => {
    let idx = s.indexOf(find);
    while (idx !== -1) {
      total += 1;
      idx = s.indexOf(find, idx + find.length);
    }
    return s;
  });
  return total;
}

export type ApplyEditsResult =
  | { ok: true; protocol: Protocol; applied: ProtocolEdit[] }
  | { ok: false; reason: string; failedEdit?: ProtocolEdit };

/**
 * Применяет замены к строковым полям протокола. Требование строгое: каждая
 * подстрока встречается ровно один раз. Иначе патч отменяется целиком —
 * лучше полная перегенерация, чем испорченный не тот пункт.
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

  for (const edit of edits) {
    const find = String(edit?.find ?? '');
    const replace = String(edit?.replace ?? '');
    if (!find.trim()) return { ok: false, reason: 'пустой find', failedEdit: edit };
    if (find === replace) continue;

    const occurrences = countOccurrences(current, find);
    if (occurrences === 0) {
      return { ok: false, reason: 'фрагмент не найден в протоколе', failedEdit: edit };
    }
    if (occurrences > 1) {
      return { ok: false, reason: `фрагмент встречается ${occurrences} раз — неоднозначно`, failedEdit: edit };
    }

    let done = false;
    current = mapStrings(current, (s) => {
      if (done) return s;
      const idx = s.indexOf(find);
      if (idx === -1) return s;
      done = true;
      return s.slice(0, idx) + replace + s.slice(idx + find.length);
    });
    applied.push({ find, replace });
  }

  if (applied.length === 0) return { ok: false, reason: 'нечего применять' };
  return { ok: true, protocol: current, applied };
}

/** Анонимизация всех строковых полей протокола (для отправки в облако). */
export function mapProtocolStrings(protocol: Protocol, fn: (s: string) => string): Protocol {
  return mapStrings(protocol, fn);
}
