import { clampMaxTokensToWindow, llmMaxModelLen } from '../ollama-limits';

describe('промпт и ответ должны помещаться в окно модели', () => {
  const OLD = process.env.LLM_MAX_MODEL_LEN;
  afterEach(() => {
    if (OLD === undefined) delete process.env.LLM_MAX_MODEL_LEN;
    else process.env.LLM_MAX_MODEL_LEN = OLD;
  });

  it('по умолчанию окно 32768 — как у qwen3.5-35b на шлюзе', () => {
    delete process.env.LLM_MAX_MODEL_LEN;
    expect(llmMaxModelLen()).toBe(32768);
  });

  it('РЕГРЕССИЯ 16.08.2026: 6555 токенов промпта + 26214 вывода не проходили в окно 32768', () => {
    delete process.env.LLM_MAX_MODEL_LEN;
    // Шлюз отвечал 400 «total of at least 32769 tokens», пользователь видел
    // вечный спиннер и пустую панель.
    const promptChars = Math.round(6555 * 2.34);
    const { max, clamped } = clampMaxTokensToWindow(promptChars, 26214);
    expect(clamped).toBe(true);
    expect(promptChars / 2.34 + max).toBeLessThan(32768);
  });

  it('запрос, который и так помещается, не трогается', () => {
    delete process.env.LLM_MAX_MODEL_LEN;
    const { max, clamped } = clampMaxTokensToWindow(2340, 4096); // ≈1000 токенов промпта
    expect(clamped).toBe(false);
    expect(max).toBe(4096);
  });

  it('окно из переменной перебивает значение по умолчанию', () => {
    process.env.LLM_MAX_MODEL_LEN = '131072';
    expect(llmMaxModelLen()).toBe(131072);
    const { clamped } = clampMaxTokensToWindow(Math.round(6555 * 2.34), 26214);
    expect(clamped).toBe(false);
  });

  it('промпт почти во всё окно — отдаём минимум, а не ноль или отрицательное', () => {
    delete process.env.LLM_MAX_MODEL_LEN;
    const { max } = clampMaxTokensToWindow(32768 * 2.34, 8192);
    expect(max).toBe(256);
  });
});
