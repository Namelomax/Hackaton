import { FIXED_CHAT_MODEL } from '../chat-models';

// insecureFetch — единственный сетевой вызов gateway-model.ts, мокаем его,
// чтобы тесты не ходили в реальную сеть.
jest.mock('../insecure-fetch');

/**
 * Реальный ответ шлюза (проверено 08.09.2026):
 *   {"object":"list","data":[{"id":"qwen3.8-27B","max_model_len":32768,
 *     "permission":[{"id":"modelperm-b3feba60fae781e2", ...}]}]}
 *
 * У вложенных permission[] тоже есть поле id (modelperm-*) — это ловушка,
 * которую проверяет регрессионный тест ниже.
 */
function gatewayResponse(data: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => ({ object: 'list', data }),
  };
}

const ENV_KEYS = [
  'GATEWAY_MODEL_DISCOVERY',
  'GATEWAY_MODEL_TTL_MS',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'ALLOWED_OLLAMA_MODELS',
  'LLM_MAX_MODEL_LEN',
] as const;

describe('lib/gateway-model', () => {
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
  let mockedInsecureFetch: jest.Mock;
  // require() вместо import — модуль хранит кэш на уровне модуля, и нам нужен
  // свежий экземпляр (свежий кэш) под каждый тест через jest.resetModules().
  let gatewayModel: typeof import('../gateway-model');

  beforeEach(() => {
    jest.resetModules();
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.GATEWAY_MODEL_DISCOVERY;
    delete process.env.GATEWAY_MODEL_TTL_MS;
    delete process.env.LLM_MAX_MODEL_LEN;
    process.env.OLLAMA_BASE_URL = 'https://oui.interfonica.cloud/v1';
    process.env.OLLAMA_API_KEY = 'test-key';

    mockedInsecureFetch = jest.fn();
    jest.doMock('../insecure-fetch', () => ({ insecureFetch: mockedInsecureFetch }));

    gatewayModel = require('../gateway-model');
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    jest.resetModules();
  });

  it('РЕГРЕССИЯ: берёт id из data[], а НЕ из вложенного permission[] (modelperm-*)', async () => {
    mockedInsecureFetch.mockResolvedValue(
      gatewayResponse([
        {
          id: 'qwen3.8-27B',
          object: 'model',
          max_model_len: 32768,
          permission: [{ id: 'modelperm-b3feba60fae781e2', object: 'model_permission' }],
        },
      ]),
    );

    const result = await gatewayModel.discoverGatewayModel();
    expect(result).not.toBeNull();
    expect(result?.id).toBe('qwen3.8-27B');
    expect(result?.id).not.toMatch(/^modelperm-/);
  });

  it('извлекает max_model_len из ответа шлюза', async () => {
    mockedInsecureFetch.mockResolvedValue(
      gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 32768 }]),
    );

    const result = await gatewayModel.discoverGatewayModel();
    expect(result?.maxModelLen).toBe(32768);
  });

  it('если в списке есть FIXED_CHAT_MODEL — выбирается он, а не первый элемент', async () => {
    mockedInsecureFetch.mockResolvedValue(
      gatewayResponse([
        { id: 'some-other-model', max_model_len: 8192 },
        { id: FIXED_CHAT_MODEL, max_model_len: 32768 },
      ]),
    );

    const result = await gatewayModel.discoverGatewayModel();
    expect(result?.id).toBe(FIXED_CHAT_MODEL);
  });

  it('если ничего из FIXED_CHAT_MODEL/ALLOWED_OLLAMA_MODELS не нашлось — берётся первый элемент data[]', async () => {
    process.env.ALLOWED_OLLAMA_MODELS = 'not-in-list-a,not-in-list-b';
    mockedInsecureFetch.mockResolvedValue(
      gatewayResponse([
        { id: 'brand-new-model', max_model_len: 65536 },
        { id: 'second-model', max_model_len: 65536 },
      ]),
    );

    const result = await gatewayModel.discoverGatewayModel();
    expect(result?.id).toBe('brand-new-model');
  });

  it('сеть упала: discoverGatewayModel() возвращает null, но ранее обнаруженное значение в кэше сохраняется', async () => {
    mockedInsecureFetch.mockResolvedValueOnce(
      gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 32768 }]),
    );
    const first = await gatewayModel.discoverGatewayModel();
    expect(first?.id).toBe('qwen3.8-27B');
    expect(gatewayModel.getCachedGatewayModel()?.id).toBe('qwen3.8-27B');

    mockedInsecureFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const second = await gatewayModel.discoverGatewayModel(true);
    expect(second).toBeNull();
    // last-known-good НЕ затёрт неудачной перепроверкой.
    expect(gatewayModel.getCachedGatewayModel()?.id).toBe('qwen3.8-27B');
  });

  it('списка моделей нет (пустой data[]) — возвращается null, кэш не трогается', async () => {
    mockedInsecureFetch.mockResolvedValue(gatewayResponse([]));
    const result = await gatewayModel.discoverGatewayModel();
    expect(result).toBeNull();
    expect(gatewayModel.getCachedGatewayModel()).toBeNull();
  });

  it('GATEWAY_MODEL_DISCOVERY=off полностью отключает обнаружение', async () => {
    process.env.GATEWAY_MODEL_DISCOVERY = 'off';
    mockedInsecureFetch.mockResolvedValue(
      gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 32768 }]),
    );

    const result = await gatewayModel.discoverGatewayModel();
    expect(result).toBeNull();
    expect(gatewayModel.getCachedGatewayModel()).toBeNull();
    expect(mockedInsecureFetch).not.toHaveBeenCalled();
  });

  it('параллельные вызовы дедуплицируются одним in-flight промисом', async () => {
    let resolveFetch!: (v: unknown) => void;
    mockedInsecureFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const p1 = gatewayModel.discoverGatewayModel();
    const p2 = gatewayModel.discoverGatewayModel();
    resolveFetch(gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 32768 }]));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.id).toBe('qwen3.8-27B');
    expect(r2?.id).toBe('qwen3.8-27B');
    expect(mockedInsecureFetch).toHaveBeenCalledTimes(1);
  });

  describe('llmMaxModelLen(): интеграция с обнаруженным окном', () => {
    it('явный LLM_MAX_MODEL_LEN перебивает обнаруженное значение', async () => {
      mockedInsecureFetch.mockResolvedValue(
        gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 65536 }]),
      );
      await gatewayModel.discoverGatewayModel();

      process.env.LLM_MAX_MODEL_LEN = '131072';
      // ollama-limits.ts тоже импортирует '../gateway-model' — берём тот же
      // require()-кэш модуля, что и gatewayModel выше, чтобы использовать
      // один и тот же module-level кэш обнаруженной модели.
      const { llmMaxModelLen } = require('../ollama-limits') as typeof import('../ollama-limits');
      expect(llmMaxModelLen()).toBe(131072);
    });

    it('без явного env — используется обнаруженный max_model_len', async () => {
      mockedInsecureFetch.mockResolvedValue(
        gatewayResponse([{ id: 'qwen3.8-27B', max_model_len: 65536 }]),
      );
      await gatewayModel.discoverGatewayModel();

      delete process.env.LLM_MAX_MODEL_LEN;
      const { llmMaxModelLen } = require('../ollama-limits') as typeof import('../ollama-limits');
      expect(llmMaxModelLen()).toBe(65536);
    });

    it('ничего не обнаружено и env не задан — дефолт 32768', () => {
      delete process.env.LLM_MAX_MODEL_LEN;
      const { llmMaxModelLen } = require('../ollama-limits') as typeof import('../ollama-limits');
      expect(llmMaxModelLen()).toBe(32768);
    });
  });
});
