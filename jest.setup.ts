import '@testing-library/jest-dom';
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from 'node:stream/web';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

// jsdom подкладывает урезанный TextDecoder, который знает только utf-8: на
// `new TextDecoder('windows-1251')` он бросает. Из-за этого определение
// кодировки в тестах молча возвращало null, хотя в проде (Node с full-ICU)
// работает. Ставим реализацию Node безусловно — она умеет все кодировки.
(globalThis as Record<string, unknown>).TextDecoder = NodeTextDecoder;
(globalThis as Record<string, unknown>).TextEncoder = NodeTextEncoder;

// jsdom не реализует Web Streams API, а серверный код (стриминг ответа LLM,
// фильтр утечки tool-call) на нём построен — без полифилла такие модули падают
// ещё на импорте с «TransformStream is not defined». Подкладываем реализацию
// Node и только там, где глобали действительно нет.
const streamGlobals = {
  ReadableStream: NodeReadableStream,
  TransformStream: NodeTransformStream,
  WritableStream: NodeWritableStream,
} as const;

for (const [name, impl] of Object.entries(streamGlobals)) {
  if (!(name in globalThis)) {
    (globalThis as Record<string, unknown>)[name] = impl;
  }
}

// jsdom не даёт Request/Response/Headers, а серверные роуты принимают именно
// Request (чтение cookie, заголовков). Берём реализацию undici — ту же, что у
// Node и Next в проде.

const undici = require('undici') as Record<string, unknown>;
for (const name of ['Request', 'Response', 'Headers', 'FormData']) {
  if (!(name in globalThis) && undici[name]) {
    (globalThis as Record<string, unknown>)[name] = undici[name];
  }
}
