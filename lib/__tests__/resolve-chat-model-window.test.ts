import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { TextDecoderStream as NodeTextDecoderStream } from 'node:stream/web';

// jest.setup.ts полифиллит ReadableStream/TransformStream/WritableStream, но не
// TextDecoderStream — его использует @ai-sdk/provider-utils при разборе SSE-ответа
// (parseJsonEventStream). Без него doStream() падает с ReferenceError ещё до того,
// как долетит до наших ассертов на тело POST-запроса.
if (!('TextDecoderStream' in globalThis)) {
  (globalThis as Record<string, unknown>).TextDecoderStream = NodeTextDecoderStream;
}

/**
 * Инцидент 17.09.2026: `discoverGatewayModel()` вызывался только на 404-ретрае
 * (переименование модели), поэтому в обычный день кэш окна модели оставался
 * пустым и `llmMaxModelLen()` отдавал фолбэк 32768 вместо реальных 65536 на
 * шлюзе. Промпт ≈32k токенов + запрошенный max_tokens=13107 не помещались в
 * 32768 → `clampMaxTokensToWindow` резал ответ до минимума (256) → JSON
 * протокола обрывался на середине.
 *
 * Тест ловит ровно этот сценарий сквозь `resolveChatLanguageModel()`: мокаем
 * оба сетевых вызова (`GET /models` для обнаружения окна и
 * `POST /chat/completions` для самой генерации) и проверяем, что в тело
 * запроса ушёл РЕАЛЬНЫЙ max_tokens=13107, а не урезанный 256.
 *
 * insecureFetch — единственный сетевой вызов и в gateway-model.ts, и в
 * resolve-chat-model.ts, мокаем его так же, как в gateway-model.test.ts.
 * Кэш в gateway-model.ts модульный — сбрасываем через jest.resetModules() и
 * require() по свежей, как в gateway-model.test.ts.
 */
jest.mock('../insecure-fetch');

const ENV_KEYS = [
  'GATEWAY_MODEL_DISCOVERY',
  'GATEWAY_MODEL_TTL_MS',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'ALLOWED_OLLAMA_MODELS',
  'LLM_MAX_MODEL_LEN',
  'LLM_FORCE_NONSTREAM',
  'OLLAMA_HARD_MAX_OUTPUT_TOKENS',
  'OLLAMA_PROTOCOL_MAX_OUTPUT_TOKENS',
] as const;

describe('resolveChatLanguageModel: проактивное обнаружение окна перед расчётом max_tokens', () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  let mockedInsecureFetch: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.GATEWAY_MODEL_DISCOVERY;
    delete process.env.GATEWAY_MODEL_TTL_MS;
    delete process.env.LLM_MAX_MODEL_LEN;
    delete process.env.ALLOWED_OLLAMA_MODELS;
    delete process.env.LLM_FORCE_NONSTREAM; // фолбэк 'true' — non-stream путь, как в проде за JupyterHub
    delete process.env.OLLAMA_HARD_MAX_OUTPUT_TOKENS;
    delete process.env.OLLAMA_PROTOCOL_MAX_OUTPUT_TOKENS;
    process.env.OLLAMA_BASE_URL = 'https://oui.interfonica.cloud/v1';
    process.env.OLLAMA_API_KEY = 'test-key';

    mockedInsecureFetch = jest.fn();
    jest.doMock('../insecure-fetch', () => ({ insecureFetch: mockedInsecureFetch }));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    jest.resetModules();
  });

  /** ≈42700 токенов промпта (2.34 симв/токен) — не помещается в окно 32768
   *  вместе с ответом, но свободно помещается в реальные 65536. */
  const longPrompt = 'а'.repeat(100000);

  function completionResponse() {
    return {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1758000000,
      model: 'qwen3.8-27B',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 42735, completion_tokens: 5, total_tokens: 42740 },
    };
  }

  /** Разбирает JSON-тело запроса, отправленного через insecureFetch. */
  function parseCallBody(call: unknown[]): Record<string, unknown> {
    const init = call[1] as RequestInit | undefined;
    return JSON.parse(init?.body as string) as Record<string, unknown>;
  }

  function mockGateway(maxModelLen: number) {
    mockedInsecureFetch.mockImplementation(async (url: unknown) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            object: 'list',
            data: [{ id: 'qwen3.8-27B', max_model_len: maxModelLen }],
          }),
        };
      }
      // POST /chat/completions
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(completionResponse()),
        json: async () => completionResponse(),
      };
    });
  }

  it('РЕГРЕССИЯ 17.09.2026: окно шлюза 65536 — max_tokens=13107 доходит до POST без урезки', async () => {
    mockGateway(65536);

    const { resolveChatLanguageModel } = require('../resolve-chat-model') as typeof import('../resolve-chat-model');
    const model = resolveChatLanguageModel({ chatProvider: 'ollama' });

    const callOptions: LanguageModelV2CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: longPrompt }] }],
      maxOutputTokens: 13107,
    };
    await (model as any).doStream(callOptions);

    const postCall = mockedInsecureFetch.mock.calls.find((call) => {
      const urlStr = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return urlStr.includes('/chat/completions');
    });
    expect(postCall).toBeDefined();
    const body = parseCallBody(postCall!);
    expect(body.max_tokens).toBe(13107);

    // Обнаружение отработало ДО расчёта max_tokens — GET /models был вызван.
    const getCall = mockedInsecureFetch.mock.calls.find((call) => {
      const urlStr = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return urlStr.endsWith('/models');
    });
    expect(getCall).toBeDefined();
  });

  it('БЕЗ обнаружения (шлюз недоступен) — фолбэк 32768 всё ещё режет max_tokens до 256 (старое поведение сохранено как страховка)', async () => {
    mockedInsecureFetch.mockImplementation(async (url: unknown) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.endsWith('/models')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(completionResponse()),
        json: async () => completionResponse(),
      };
    });

    const { resolveChatLanguageModel } = require('../resolve-chat-model') as typeof import('../resolve-chat-model');
    const model = resolveChatLanguageModel({ chatProvider: 'ollama' });

    const callOptions: LanguageModelV2CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: longPrompt }] }],
      maxOutputTokens: 13107,
    };
    await (model as any).doStream(callOptions);

    const postCall = mockedInsecureFetch.mock.calls.find((call) => {
      const urlStr = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return urlStr.includes('/chat/completions');
    });
    expect(postCall).toBeDefined();
    const body = parseCallBody(postCall!);
    expect(body.max_tokens).toBe(256);
  });
});
