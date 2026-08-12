/**
 * Утечка «текстового вызова инструмента» в ответ пользователю.
 *
 * Локальная модель (gemma-4-31b) не умеет нативные tool-calls: у Gemma нет
 * соответствующих токенов, и шаблон Ollama их не разбирает. Инструмент уходит
 * в запросе полем `tools`, Ollama вклеивает его описание в промпт — а обратно
 * ничего не парсит, `message.tool_calls` приходит пустым. Модель, зная про
 * инструмент из промпта, выдумывает похожий на спецтокены синтаксис и пишет
 * его обычным текстом. Реальный пример из БД:
 *
 *   <|tool_call>call:publishInvestigationProtocol{reasonBrief:<|"|>…<|"|>}<tool_call|>
 *
 * Обратите внимание: границы несимметричные («<|tool_call>» открывает,
 * «<tool_call|>» закрывает), «кавычки» — «<|"|>». Такого формата нет ни у одной
 * модели, поэтому разбирать его как протокол бессмысленно — его нужно
 * ОБНАРУЖИТЬ (чтобы сработал детерминированный фолбэк генерации документа) и
 * ВЫРЕЗАТЬ из того, что видит пользователь.
 *
 * Модуль намеренно не привязан к одному написанию: ловим любые вариации
 * tool_call-границ и имя самого инструмента.
 */

/** Имена инструментов, которые модель может «позвать» текстом. */
const TOOL_NAMES = ['publishInvestigationProtocol', 'retrieveFromIndexedDocuments'];

/**
 * Граница псевдовызова: `<tool_call>`, `<|tool_call|>`, `<|tool_call>`,
 * `<tool_call|>`, `</tool_call>`, `<|tool_calls|>` и прочие сочетания палок,
 * слешей и пробелов вокруг слова.
 */
const TOOL_TAG_SRC = String.raw`<\s*\|?\s*\/?\s*tool_calls?\s*\/?\s*\|?\s*>`;

/** Артефакт «кавычки» из того же выдуманного синтаксиса. */
const FAKE_QUOTE_RE = /<\|"\|>|<\|">/g;

/** Полный блок псевдовызова: открывающая граница … закрывающая граница. */
const LEAK_BLOCK_RE = new RegExp(`${TOOL_TAG_SRC}[\\s\\S]*?${TOOL_TAG_SRC}`, 'gi');

/** Незакрытый псевдовызов — режем до конца текста. */
const LEAK_OPEN_TAIL_RE = new RegExp(`${TOOL_TAG_SRC}[\\s\\S]*$`, 'i');

/** Голый вызов без границ: `call: publishInvestigationProtocol{…}`. */
const BARE_CALL_RE = new RegExp(
  String.raw`(?:^|\s)call\s*:\s*(?:${TOOL_NAMES.join('|')})\s*\{[\s\S]*?\}`,
  'gi',
);

/** Одиночное упоминание имени инструмента (промпт его запрещает — значит, утечка). */
const TOOL_NAME_RE = new RegExp(TOOL_NAMES.join('|'), 'i');

/** Параметр инструмента, написанный текстом: `"reasonBrief": …`, `[reasonBrief: …`. */
const REASON_BRIEF_RE = /"?reasonBrief"?\s*:/i;

/**
 * Похоже ли, что модель «позвала» инструмент текстом вместо настоящего вызова.
 *
 * Раньше признак был один — подстрока `reasonBrief:`. Он сработал на живом
 * примере, но держаться на нём одном нельзя: стоит модели написать псевдовызов
 * без имени параметра, и правка потеряется молча — документ не пересоберётся,
 * а пользователю уйдёт «правки внесены».
 */
export function looksLikeTextualToolCall(text: string): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  return (
    REASON_BRIEF_RE.test(t) ||
    TOOL_NAME_RE.test(t) ||
    new RegExp(TOOL_TAG_SRC, 'i').test(t)
  );
}

/** Вырезает псевдовызовы из текста, оставляя нормальную часть ответа. */
export function stripToolCallLeak(text: string): string {
  const src = String(text ?? '');
  if (!src) return src;
  let out = src.replace(LEAK_BLOCK_RE, ' ');
  out = out.replace(BARE_CALL_RE, ' ');
  // Осталась открывающая граница без пары — всё после неё уже мусор.
  out = out.replace(LEAK_OPEN_TAIL_RE, ' ');
  out = out.replace(FAKE_QUOTE_RE, '"');
  // Схлопываем дыры, оставшиеся от вырезанных блоков.
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Первая позиция, с которой текст МОЖЕТ оказаться началом псевдовызова.
 * Всё до неё безопасно отдавать в чат сразу; всё после — придерживаем, пока не
 * станет ясно, вызов это или обычный текст.
 */
const POSSIBLE_MARKER_RE = /<|(?:^|\W)call\s*:/i;

function firstPossibleMarker(text: string): number {
  const m = POSSIBLE_MARKER_RE.exec(text);
  return m ? m.index : -1;
}

/**
 * Потоковая чистка: разбивает накопленный текст на «стабильную» часть, которую
 * уже нельзя испортить будущими чанками, и «отложенную».
 *
 * Почему нельзя просто чистить каждый чанк: граница псевдовызова легко
 * разрывается между чанками («<|tool» + «_call>»), да и целиком блок становится
 * виден только когда придёт закрывающая граница — а к тому моменту его начало
 * уже уехало бы пользователю. Поэтому режем по ПЕРВОМУ возможному маркеру:
 * префикс до него маркеров не содержит вовсе, значит он окончателен.
 */
export function splitStableAndPending(buffer: string): [stable: string, pending: string] {
  const idx = firstPossibleMarker(buffer);
  if (idx === -1) return [buffer, ''];
  return [buffer.slice(0, idx), buffer.slice(idx)];
}

type StreamChunk = Record<string, unknown>;

/**
 * Оборачивает UI-поток чат-агента так, чтобы псевдовызов не попал ни в чат,
 * ни в сохранённую историю. Чанки, кроме `text-delta`/`text-end`, проходят как есть.
 */
export function filterToolCallLeakStream<T>(stream: ReadableStream<T>): ReadableStream<T> {
  /** id текстового блока → { сколько накопили, сколько уже отдали }. */
  const state = new Map<string, { buffer: string; emitted: number }>();

  const transform = new TransformStream<T, T>({
    transform(chunk, controller) {
      const c = chunk as unknown as StreamChunk;
      const type = typeof c?.type === 'string' ? c.type : '';
      const id = typeof c?.id === 'string' ? c.id : '';

      if (type === 'text-delta' && id) {
        const st = state.get(id) ?? { buffer: '', emitted: 0 };
        st.buffer += typeof c.delta === 'string' ? c.delta : '';
        const [stable] = splitStableAndPending(st.buffer);
        if (stable.length > st.emitted) {
          controller.enqueue({
            ...c,
            delta: stable.slice(st.emitted),
          } as unknown as T);
          st.emitted = stable.length;
        }
        state.set(id, st);
        return;
      }

      if (type === 'text-end' && id) {
        const st = state.get(id);
        if (st) {
          const [, pending] = splitStableAndPending(st.buffer);
          const tail = stripToolCallLeak(pending);
          if (tail) {
            controller.enqueue({ type: 'text-delta', id, delta: tail } as unknown as T);
          }
          state.delete(id);
        }
        controller.enqueue(chunk);
        return;
      }

      controller.enqueue(chunk);
    },
    flush(controller) {
      // Поток оборвался без text-end — не теряем придержанный хвост.
      for (const [id, st] of state) {
        const [, pending] = splitStableAndPending(st.buffer);
        const tail = stripToolCallLeak(pending);
        if (tail) {
          controller.enqueue({ type: 'text-delta', id, delta: tail } as unknown as T);
        }
      }
      state.clear();
    },
  });

  return stream.pipeThrough(transform);
}
