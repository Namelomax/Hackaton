import { ReadableStream, TransformStream } from 'node:stream/web';
import { TextEncoder, TextDecoder } from 'node:util';

// testEnvironment здесь — 'jsdom' (см. jest.config.js), а jsdom не предоставляет
// глобальные Streams API/Response/TextEncoder — они нужны и самому
// sse-deanonymize.ts (использует их как амбиентные глобалы), и этому тесту.
// Подставляем реализацию из Node только в рамках текущего файла, без новых
// зависимостей в package.json.
class ResponsePolyfill {
  body: ReadableStream<any> | null;
  status: number;
  statusText: string;
  headers: unknown;
  constructor(
    body: ReadableStream<any> | null = null,
    init: { status?: number; statusText?: string; headers?: unknown } = {},
  ) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = init.headers ?? {};
  }
}

const g = globalThis as any;
g.ReadableStream = g.ReadableStream ?? ReadableStream;
g.TransformStream = g.TransformStream ?? TransformStream;
g.TextEncoder = g.TextEncoder ?? TextEncoder;
g.TextDecoder = g.TextDecoder ?? TextDecoder;
g.Response = g.Response ?? ResponsePolyfill;

import { wrapResponseWithDeanonymization } from '../sse-deanonymize';
import type { Mapping } from '../types';

/** Собирает Response, тело которого эмитит переданные чанки (строки или байты). */
function makeSseResponse(chunks: (string | Uint8Array)[]): Response {
  const stream = new ReadableStream<any>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new (Response as any)(stream) as Response;
}

async function readAllText(response: Response): Promise<string> {
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe('wrapResponseWithDeanonymization — регресс Бага 1 (строковые чанки)', () => {
  const mapping: Mapping = { '[PERSON_1]': 'Иванов Пётр' };
  const sseBody =
    'data: {"type":"data-documentDelta","data":"Подписал [PERSON_1]"}\n\n' +
    'data: {"type":"data-finish","data":null}\n\n';

  it('обрабатывает поток СО СТРОКОВЫМИ чанками без исключений и деанонимизирует данные', async () => {
    const response = makeSseResponse([sseBody]);

    const wrapped = wrapResponseWithDeanonymization(response, mapping);
    const text = await readAllText(wrapped);

    expect(text).toContain('Иванов Пётр');
    expect(text).not.toContain('[PERSON_1]');
  });

  it('обрабатывает поток С БАЙТОВЫМИ чанками (Uint8Array) — базовый случай', async () => {
    const encoder = new TextEncoder();
    const response = makeSseResponse([encoder.encode(sseBody)]);

    const wrapped = wrapResponseWithDeanonymization(response, mapping);
    const text = await readAllText(wrapped);

    expect(text).toContain('Иванов Пётр');
    expect(text).not.toContain('[PERSON_1]');
  });
});
