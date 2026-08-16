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

import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import {
  extractNoObjectGeneratedText,
  parseLooseJsonObject,
  type Protocol,
} from '@/lib/schemas/protocol-schema';
import { documentReasoningOptions, formatUsage } from '@/lib/reasoning-options';
import { buildDateContextBlock, parseRuDate, resolveRelativeDatesInText } from '@/lib/date-context';

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
5. Даты. «Завтра», «послезавтра», «через неделю», «в четверг» считай ОТ ДАТЫ ОБРАБОТКИ из блока [КОНТЕКСТ ДАТЫ] ниже, а сроки внутри протокола — от даты встречи из шапки. Никогда не бери дату «из головы»: если посчитать не от чего, оставь «требует уточнения».
5.1. Срок не может быть РАНЬШЕ даты встречи — это будущее действие. Получилась более ранняя дата — значит расчёт неверный, оставь маркер уточнения.
6. canPatch = false, если правка требует пересборки структуры: добавить/убрать участника, пункт повестки, раздел, переписать «Обсудили» целиком, поменять нумерацию. В этом случае edits оставь пустым и ОБЯЗАТЕЛЬНО заполни reason — одной фразой, что именно мешает («добавляется участник», «меняются все сроки»). Пустой reason недопустим.
6.1. canPatch = false и для МАССОВЫХ правок, где одно и то же поле меняется по всему документу с разным окружением: «все сроки поставь на …», «везде смени ответственного», «проставь даты во всех пунктах». Точечные замены для этого не годятся — такие правки делает полная пересборка. Не пытайся выразить их десятком замен.
6.2. "find" НИКОГДА не должен быть голым значением — датой, числом, одним словом. Это приведёт к замене в случайном месте. Всегда бери фразу целиком, вместе с окружением: не «28.07.2026», а «Срок: 28.07.2026. Ответственный: Исполнитель».
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
  /**
   * Замечания к предыдущей попытке: какие "find" не нашлись или оказались
   * неоднозначными. Планировщик получает их и берёт кусок длиннее.
   */
  previousFailures?: string[];
}): Promise<ProtocolPatchPlan> {
  const { model, documentMarkdown, userRequest, abortSignal, previousFailures } = options;
  // Текст просьбы НЕ переписываем — решает модель. Но если в ней есть
  // относительная дата, считаем её и кладём рядом готовой подсказкой: модель
  // сама плохо считает от «сегодня» (выдавала то 20.06.2025, то сегодняшнее
  // число вместо завтрашнего), а с посчитанным значением ошибиться негде.
  const today = new Date();
  const resolved = resolveRelativeDatesInText(userRequest, today);
  const dateHint = resolved.resolutions.length
    ? `\n\n[РАСЧЁТ ДАТ ПО ПРОСЬБЕ: ${resolved.resolutions
        .map((r) => `«${r.from}» = ${r.to}`)
        .join('; ')}. Используй именно эти значения.]`
    : '';
  if (dateHint) console.log(`[protocol-patch] подсказка по датам:${dateHint.trim()}`);

  // Справку о дате кладём В НАЧАЛО: в хвосте промпта длиной в десятки тысяч
  // символов модель её попросту не замечала.
  const retryBlock =
    previousFailures && previousFailures.length > 0
      ? '\n\n=== ПРЕДЫДУЩАЯ ПОПЫТКА НЕ ПРОШЛА ===\n' +
        previousFailures.map((f) => `- ${f}`).join('\n') +
        '\nВерни замены заново. Для каждого проблемного места возьми БОЛЬШЕ окружающего текста, ' +
        'чтобы "find" встречался в протоколе ровно один раз: добавь начало предложения, ' +
        'название пункта повестки или соседнюю фразу. Копируй символ в символ из протокола выше.'
      : '';

  const prompt =
    buildDateContextBlock(today).trim() +
    '\n\n' +
    PATCH_PLANNER_PROMPT.replace('{{DOCUMENT}}', documentMarkdown).replace(
      '{{REQUEST}}',
      userRequest + dateHint,
    ) +
    retryBlock;

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
    // Модель часто заворачивает JSON в ```json … ``` или добавляет пояснение до
    // и после. В основной генерации такой ответ восстанавливается, а
    // планировщик просто падал с «Invalid JSON response» и уводил на полную
    // пересборку. Пробуем достать объект из сырого текста тем же способом.
    const raw = extractNoObjectGeneratedText(err);
    const recovered = raw ? parseLooseJsonObject(raw) : null;
    if (recovered) {
      const parsed = PatchPlanSchema.safeParse(recovered);
      if (parsed.success) {
        console.warn('[protocol-patch] план восстановлен из «грязного» ответа модели');
        return parsed.data;
      }
      console.warn('[protocol-patch] восстановленный ответ не подошёл под схему плана');
    }

    // Запасной путь без structured output.
    //
    // generateObject просит у шлюза response_format: json_schema. vLLM отвечает
    // на это 400, если поднят без guided decoding — ровно так же, как отверг
    // поле `tools` (см. chat-agent). Тогда планировщик молча возвращал
    // canPatch=false, и точечные правки НИКОГДА не срабатывали, а по логам это
    // выглядело как «модель решила, что патчить нельзя».
    // Тот же приём уже применён в lib/anonymization/verify-inflected.ts.
    try {
      const { text } = await generateText({
        model,
        prompt: prompt + '\n\nОтветь ТОЛЬКО JSON-объектом, без пояснений и без ```.',
        temperature: 0,
        maxOutputTokens: 2048,
        providerOptions: documentReasoningOptions(),
        ...(abortSignal ? { abortSignal } : {}),
      });
      const obj = parseLooseJsonObject(String(text ?? ''));
      const parsed = obj ? PatchPlanSchema.safeParse(obj) : null;
      if (parsed?.success) {
        console.warn('[protocol-patch] план получен запасным путём (без structured output)');
        return parsed.data;
      }
      console.warn('[protocol-patch] запасной путь: ответ не подошёл под схему плана');
    } catch (fallbackErr) {
      console.warn(
        '[protocol-patch] запасной путь тоже не отработал:',
        (fallbackErr as Error)?.message ?? fallbackErr,
      );
    }

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
 * Разбирает замену, записанную СТРОКОЙ ТАБЛИЦЫ, на замены по ячейкам.
 *
 * Корень проблемы структурный: планировщик видит MARKDOWN (`protocolToMarkdown`),
 * а замены применяются к Protocol JSON — там ФИО и должность лежат отдельными
 * полями `fullName` и `position`, и строки «Иванов И.И. | инженер» не существует
 * ни в одном поле. Такой `find` не найдётся НИКОГДА, по построению.
 *
 * Промпт это запрещает (правило 1.1 про символы «|»), но слабая модель правило
 * нарушает — на стенде так и случилось:
 *   find = «Ковалёв Сергей Андреевич | начальник департамента эксплуатации»
 *   → фрагмент не найден → полная генерация вместо точечной правки.
 *
 * Если число ячеек совпадает, спариваем их и оставляем только изменившиеся:
 * из строки целиком получается ровно одна настоящая замена — должность.
 */
export function expandTableRowEdits(edits: ProtocolEdit[]): ProtocolEdit[] {
  const out: ProtocolEdit[] = [];
  for (const edit of edits ?? []) {
    const find = String(edit?.find ?? '');
    const replace = String(edit?.replace ?? '');

    if (!find.includes('|') || !replace.includes('|')) {
      out.push(edit);
      continue;
    }

    // Ведущий и хвостовой «|» у markdown-строки дают пустые ячейки — убираем.
    const cells = (s: string) =>
      s.split('|').map((c) => c.trim()).filter((c, i, arr) => !(c === '' && (i === 0 || i === arr.length - 1)));
    const f = cells(find);
    const r = cells(replace);

    if (f.length < 2 || f.length !== r.length) {
      // Спарить не получилось — отдаём как есть, пусть отработают прежние
      // спасательные попытки ниже по коду.
      out.push(edit);
      continue;
    }

    // Меняться должна ОДНА ячейка. Если модель переписала строку целиком —
    // и ФИО, и должность, — значит она метит не в ту строку либо переставляет
    // людей. Разбирать такое нельзя: раньше подобная замена просто не
    // находилась и патч честно уходил в полную генерацию, где модель видела
    // весь документ. Сохраняем этот предохранитель.
    const diffIndexes = f.map((_, i) => i).filter((i) => f[i] && r[i] && f[i] !== r[i]);
    if (diffIndexes.length !== 1) {
      console.log(
        `[protocol-patch] строка таблицы не разобрана: изменившихся ячеек ${diffIndexes.length}, ожидалась одна`,
      );
      out.push(edit);
      continue;
    }

    const changed: ProtocolEdit[] = diffIndexes.map((i) => ({ find: f[i], replace: r[i] }));

    if (changed.length === 0) {
      out.push(edit);
      continue;
    }

    console.log(
      `[protocol-patch] строка таблицы разобрана на ячейки: ${changed
        .map((c) => `«${c.find}» → «${c.replace}»`)
        .join('; ')}`,
    );
    out.push(...changed);
  }
  return out;
}

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
  // Строки таблиц из markdown раскладываем на ячейки ДО основного цикла —
  // иначе такая замена гарантированно не найдётся в полях JSON.
  edits = expandTableRowEdits(edits);
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, reason: 'пустой список замен' };
  }

  let current = protocol;
  const applied: ProtocolEdit[] = [];
  const warnings: string[] = [];
  // Патч не проходит через гарды полной сборки (enforceDateProvenance и др.),
  // поэтому выдуманную дату здесь ловить больше некому. Минимальная проверка:
  // срок не может быть раньше даты встречи.
  const meetingDate = parseRuDate((protocol as any)?.meetingDate);

  for (const edit of edits) {
    let find = String(edit?.find ?? '');
    const replace = String(edit?.replace ?? '');
    if (!find.trim()) continue;
    if (find.trim() === replace.trim()) continue; // замена сама на себя — пустая работа

    // Голое значение как «якорь» — гарантированный промах: на стенде модель
    // прислала десять замен с find="28.07.2026", и каждая била в случайное
    // место (первым шло число из шапки, а не срок). Фрагмент без окружения
    // не принимаем: такую правку сделает полная пересборка.
    const bare = find.trim();
    const isBareValue =
      /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(bare) || /^[\d\s.,%№-]+$/.test(bare) || bare.length < 12;
    if (isBareValue) {
      warnings.push(
        `фрагмент «${bare}» слишком короткий и встречается в разных местах — правка по нему не применялась`,
      );
      console.log(`[protocol-patch] пропуск: голое значение в find — "${bare}"`);
      continue;
    }

    if (meetingDate && /срок/i.test(find + ' ' + replace)) {
      const bad = [...replace.matchAll(/\b(\d{2})\.(\d{2})\.(\d{4})\b/g)]
        .map((m) => ({ raw: m[0], date: parseRuDate(m[0]) }))
        .find((d) => d.date && d.date.getTime() < meetingDate.getTime());
      if (bad) {
        warnings.push(
          `срок ${bad.raw} раньше даты встречи — замена пропущена, укажите дату явно`,
        );
        console.log(`[protocol-patch] пропуск: срок ${bad.raw} раньше даты встречи`);
        continue;
      }
    }

    // В полях Protocol JSON значка ⚠️ нет — он навешивается при отрисовке
    // markdown. Модель всё равно копирует его из текста, поэтому подстраховываемся:
    // не нашли как есть — ищем очищенный вариант.
    if (countOccurrences(current, find) === 0) {
      const normalized = find.replace(/⚠️/g, '').replace(/\s{2,}/g, ' ').trim();
      if (normalized && normalized !== find && countOccurrences(current, normalized) > 0) {
        find = normalized;
      }
    }

    // Хвостовая пунктуация: модель дописывает точку, которой в поле нет
    // («…Ответственный: Исполнитель, Заказчик.» против «…Заказчик» в JSON).
    if (countOccurrences(current, find) === 0) {
      const trimmed = find.replace(/[.,;:\s]+$/u, '');
      if (trimmed && trimmed !== find && countOccurrences(current, trimmed) > 0) {
        find = trimmed;
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
      warnings.push(`NOTFOUND:не нашёл в протоколе фрагмент «${find.slice(0, 70)}»`);
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
        // РАНЬШЕ здесь менялось первое вхождение. Это и есть та самая тихая
        // порча документа, из-за которой патч выключали: просили сменить срок в
        // третьем пункте, а менялся первый, и пользователь видел «правка
        // внесена». Промах строкой хуже, чем непроставленная правка: непроставленную
        // видно, подменённую — нет.
        warnings.push(
          `AMBIGUOUS:фрагмент «${find.slice(0, 60)}» встречается ${occurrences} раз — нужен более длинный кусок текста`,
        );
        console.log(
          `[protocol-patch] пропуск: неоднозначный фрагмент (${occurrences} вхождений) — "${find.slice(0, 60)}"`,
        );
        continue;
      }
    }

    // Дата встречи и номер протокола живут в шапке и сроками не являются.
    // Правка сроков не должна их задевать — иначе «поставь сроки на завтра»
    // сдвигает дату самой встречи.
    const isDeadlineEdit = /срок/i.test(find + ' ' + replace);
    const header = isDeadlineEdit
      ? {
          meetingDate: (current as any)?.meetingDate,
          protocolNumber: (current as any)?.protocolNumber,
          contractDate: (current as any)?.contractDate,
        }
      : null;

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
    if (header) {
      current = {
        ...(current as any),
        meetingDate: header.meetingDate,
        protocolNumber: header.protocolNumber,
        ...(header.contractDate !== undefined ? { contractDate: header.contractDate } : {}),
      } as Protocol;
    }

    applied.push({ find, replace });
    if (replaceAll && occurrences > 1) {
      console.log(`[protocol-patch] замена применена во всех ${occurrences} местах: "${find.slice(0, 50)}"`);
    }
  }

  // Ноль применённых замен — это НЕ ошибка разбора, а результат: замены были,
  // но каждая оказалась неоднозначной или не нашлась. Возвращаем ok вместе с
  // warnings, чтобы вызывающий код мог переспросить планировщика с разбором
  // промаха. Раньше здесь стоял ok:false, и warnings терялись ровно в том
  // случае, когда они нужнее всего. Решение «уйти на полную генерацию»
  // принимает вызывающий код по пустому applied.
  if (applied.length === 0) {
    return { ok: true, protocol, applied: [], warnings: [...new Set(warnings)] };
  }
  // Одинаковые предупреждения по десятку однотипных замен читать невозможно.
  return { ok: true, protocol: current, applied, warnings: [...new Set(warnings)] };
}

/** Анонимизация всех строковых полей протокола (для отправки в облако). */
export function mapProtocolStrings(protocol: Protocol, fn: (s: string) => string): Protocol {
  return mapStrings(protocol, fn);
}
