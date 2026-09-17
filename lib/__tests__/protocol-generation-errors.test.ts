import {
  extractGenerationFailureInfo,
  buildGenerationFailureMessage,
} from '../protocol-generation-errors';

describe('extractGenerationFailureInfo', () => {
  it('достаёт finishReason и inputTokens (usage.inputTokens) из ошибки AI SDK', () => {
    const err = {
      message: 'No object generated: could not parse the response.',
      finishReason: 'length',
      usage: { inputTokens: 32229, outputTokens: 256, totalTokens: 32485 },
    };
    expect(extractGenerationFailureInfo(err)).toEqual({
      finishReason: 'length',
      inputTokens: 32229,
    });
  });

  it('падает обратно на usage.promptTokens, если inputTokens нет', () => {
    const err = { finishReason: 'length', usage: { promptTokens: 1000 } };
    expect(extractGenerationFailureInfo(err)).toEqual({
      finishReason: 'length',
      inputTokens: 1000,
    });
  });

  it('неожиданная форма объекта — не бросает, возвращает null-поля', () => {
    expect(extractGenerationFailureInfo(null)).toEqual({
      finishReason: undefined,
      inputTokens: null,
    });
    expect(extractGenerationFailureInfo('строка вместо объекта')).toEqual({
      finishReason: undefined,
      inputTokens: null,
    });
  });

  it('нечисловой inputTokens игнорируется', () => {
    const err = { usage: { inputTokens: 'много' } };
    expect(extractGenerationFailureInfo(err).inputTokens).toBeNull();
  });
});

describe('buildGenerationFailureMessage', () => {
  it("finishReason==='length' — честное сообщение про окно модели с цифрами", () => {
    const msg = buildGenerationFailureMessage({ finishReason: 'length', inputTokens: 32229 }, 32768);
    expect(msg).toContain('промпт занял ~32229 токенов');
    expect(msg).toContain('окне модели 32768');
    expect(msg).toContain('Сократите расшифровку или разбейте её на части.');
  });

  it("finishReason==='length', но inputTokens неизвестен — без цифры промпта", () => {
    const msg = buildGenerationFailureMessage({ finishReason: 'length', inputTokens: null }, 65536);
    expect(msg).not.toMatch(/промпт занял ~/);
    expect(msg).toContain('65536');
  });

  it('иной finishReason — прежнее сообщение про пустой ответ, с обновлённым советом (без прежнего)', () => {
    const msg = buildGenerationFailureMessage({ finishReason: 'other', inputTokens: null }, 32768);
    expect(msg).toBe(
      'Модель дважды вернула пустой ответ при сборке протокола (перегрузка или лимит бесплатного слага). ' +
        'Повторите генерацию через минуту.',
    );
  });

  it('finishReason не определён (undefined) — тоже прежнее сообщение', () => {
    const msg = buildGenerationFailureMessage({ finishReason: undefined, inputTokens: null }, 32768);
    expect(msg).toContain('Модель дважды вернула пустой ответ');
  });
});
