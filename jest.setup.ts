import '@testing-library/jest-dom';
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream,
} from 'node:stream/web';

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
