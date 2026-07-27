/**
 * Деанонимизация UIMessage-SSE-потока «на лету».
 *
 * Ответ агентов — это поток событий `data: {json}\n\n`. Облачная модель отвечает
 * с плейсхолдерами; пользователю нужно видеть реальные данные. Здесь мы
 * перехватываем текстовые дельты (`text-delta`) и дельты документа
 * (`data-documentDelta`) и подставляем оригиналы по mapping.
 *
 * Плейсхолдер вида `[PERSON_1]` может «разрезаться» между двумя дельтами
 * (модель стримит по токенам), поэтому держим хвостовой буфер (carry) на каждый
 * текстовый поток и не деанонимизируем незавершённый `[…`.
 *
 * `data-docx` (base64 готового файла) НЕ трогаем — он формируется из уже
 * деанонимизированных данных в document-agent.
 */
import { deanonymize } from './deanonymize';
import type { Mapping } from './types';

/** Похоже ли начало строки на незавершённый плейсхолдер (`[`, `[PER`, `[ORG_1`)? */
const PARTIAL_PLACEHOLDER_RE = /\[[A-Z_]*\d*$/;
const MAX_CARRY = 40; // длиннее любого реального плейсхолдера → это не плейсхолдер

/** Делит текст на «безопасную» часть и хвост-кандидат плейсхолдера. */
function splitSafe(combined: string): { safe: string; carry: string } {
  const lastOpen = combined.lastIndexOf('[');
  if (lastOpen === -1) return { safe: combined, carry: '' };
  // Есть ли закрывающая скобка после последней открывающей?
  if (combined.indexOf(']', lastOpen) !== -1) return { safe: combined, carry: '' };
  const tail = combined.slice(lastOpen);
  if (tail.length > MAX_CARRY || !PARTIAL_PLACEHOLDER_RE.test(tail)) {
    return { safe: combined, carry: '' };
  }
  return { safe: combined.slice(0, lastOpen), carry: tail };
}

class CarryBuffers {
  private buffers = new Map<string, string>();

  /** Добавить текст в поток key, вернуть деанонимизированную безопасную часть. */
  push(key: string, text: string, mapping: Mapping): string {
    const combined = (this.buffers.get(key) ?? '') + text;
    const { safe, carry } = splitSafe(combined);
    this.buffers.set(key, carry);
    return deanonymize(safe, mapping);
  }

  /** Слить остаток потока key (деанонимизированный) и очистить буфер. */
  flush(key: string, mapping: Mapping): string {
    const carry = this.buffers.get(key) ?? '';
    this.buffers.delete(key);
    return carry ? deanonymize(carry, mapping) : '';
  }

  clear(key: string): void {
    this.buffers.delete(key);
  }
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Оборачивает Response агента так, чтобы клиент получал деанонимизированный текст.
 * Если mapping пуст — возвращает исходный Response без накладных расходов.
 */
export function wrapResponseWithDeanonymization(
  response: Response,
  mapping: Mapping,
): Response {
  if (!mapping || Object.keys(mapping).length === 0 || !response.body) {
    return response;
  }

  const carries = new CarryBuffers();
  const DOC_KEY = '__doc__';
  let textBuf = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const processEvent = (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    // raw — один SSE-блок (может содержать несколько строк, включая `data:`)
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith('data:')) {
      controller.enqueue(encoder.encode(raw + '\n\n'));
      return;
    }
    const jsonStr = trimmed.replace(/^data:\s*/, '');
    if (jsonStr === '[DONE]') {
      controller.enqueue(encoder.encode(raw + '\n\n'));
      return;
    }

    let evt: any;
    try {
      evt = JSON.parse(jsonStr);
    } catch {
      controller.enqueue(encoder.encode(raw + '\n\n'));
      return;
    }

    const emit = (o: unknown) => controller.enqueue(encoder.encode(sse(o)));

    switch (evt?.type) {
      case 'text-delta': {
        const key = `text:${evt.id ?? ''}`;
        const out = carries.push(key, String(evt.delta ?? ''), mapping);
        emit({ ...evt, delta: out });
        return;
      }
      case 'text-end': {
        const key = `text:${evt.id ?? ''}`;
        const rest = carries.flush(key, mapping);
        if (rest) emit({ type: 'text-delta', id: evt.id, delta: rest });
        emit(evt);
        return;
      }
      case 'data-documentDelta': {
        const out = carries.push(DOC_KEY, String(evt.data ?? ''), mapping);
        emit({ ...evt, data: out });
        return;
      }
      case 'data-clear': {
        carries.clear(DOC_KEY);
        emit(evt);
        return;
      }
      // Полная замена содержимого панели: текст приходит целиком, «разрезанных»
      // плейсхолдеров быть не может — подставляем оригиналы сразу и сбрасываем
      // буфер дельт. Без этой ветки пользователь видел в панели [DATE_1] и
      // [PERSON_1] вместо реальных данных.
      case 'data-documentSet': {
        carries.clear(DOC_KEY);
        emit({ ...evt, data: deanonymize(String(evt.data ?? ''), mapping) });
        return;
      }
      // Точечные правки: деанонимизируем обе стороны каждой замены, иначе на
      // клиенте фрагмент не найдётся (в панели реальные данные, в правке —
      // плейсхолдеры).
      case 'data-documentEdits': {
        const edits = Array.isArray(evt.data) ? evt.data : [];
        emit({
          ...evt,
          data: edits.map((e: any) => ({
            find: deanonymize(String(e?.find ?? ''), mapping),
            replace: deanonymize(String(e?.replace ?? ''), mapping),
          })),
        });
        return;
      }
      case 'data-finish': {
        const rest = carries.flush(DOC_KEY, mapping);
        if (rest) emit({ type: 'data-documentDelta', data: rest, transient: true });
        emit(evt);
        return;
      }
      case 'data-title': {
        emit({ ...evt, data: deanonymize(String(evt.data ?? ''), mapping) });
        return;
      }
      default:
        emit(evt);
    }
  };

  const transform = new TransformStream<Uint8Array | string, Uint8Array>({
    transform(chunk, controller) {
      // Defense-in-depth: чанк ожидается байтовым (см. document-agent.ts,
      // где поток теперь явно кодируется через TextEncoderStream), но на
      // случай если какой-то источник отдаст строку напрямую — не падаем.
      textBuf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let idx: number;
      // Делим по границам SSE-событий (\n\n)
      while ((idx = textBuf.indexOf('\n\n')) !== -1) {
        const raw = textBuf.slice(0, idx);
        textBuf = textBuf.slice(idx + 2);
        if (raw.length > 0) processEvent(raw, controller);
      }
    },
    flush(controller) {
      const tail = textBuf.trim();
      if (tail.length > 0) processEvent(tail, controller);
      // Дослить незакрытые текстовые буферы (на случай отсутствия text-end)
      const restDoc = carries.flush('__doc__', mapping);
      if (restDoc) {
        controller.enqueue(encoder.encode(sse({ type: 'data-documentDelta', data: restDoc, transient: true })));
      }
    },
  });

  const newBody = response.body.pipeThrough(transform);
  return new Response(newBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Добавляет видимое текстовое сообщение в начало UIMessage-SSE-потока
 * (например, уведомление «использую локальную модель»).
 */
export function prependNoticeToResponse(response: Response, notice: string): Response {
  if (!notice || !response.body) return response;
  const encoder = new TextEncoder();
  const id = `notice-${Date.now()}`;
  const prefix =
    sse({ type: 'text-start', id }) +
    sse({ type: 'text-delta', id, delta: notice + '\n\n' }) +
    sse({ type: 'text-end', id });

  const original = response.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(prefix));
      const reader = original.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Defense-in-depth: исходный поток ожидается байтовым, но на
          // случай строковых чанков — приводим к Uint8Array перед enqueue.
          if (value) controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
