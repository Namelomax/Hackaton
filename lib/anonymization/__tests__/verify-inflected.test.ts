import { __parseVerdictLinesForTests as parseVerdictLines } from '../verify-inflected';
import type { InflectionCandidate } from '../merge-inflected';

const asked = [
  { drop: '[PERSON_4]', keep: '[PERSON_3]' },
  { drop: '[LOCATION_1]', keep: '[PERSON_2]' },
] as unknown as InflectionCandidate[];

describe('parseVerdictLines — ответ слабой локальной модели', () => {
  it('разбирает «1: да / 2: нет»', () => {
    expect(parseVerdictLines('1: да\n2: нет', asked)).toEqual({
      '[PERSON_4]': true,
      '[LOCATION_1]': false,
    });
  });

  it('терпит другие разделители и регистр', () => {
    expect(parseVerdictLines('1) ДА\n2. No', asked)).toEqual({
      '[PERSON_4]': true,
      '[LOCATION_1]': false,
    });
  });

  it('игнорирует болтовню вокруг ответа', () => {
    expect(parseVerdictLines('Конечно, вот мой ответ:\n1: да\nСпасибо!', asked)).toEqual({
      '[PERSON_4]': true,
    });
  });

  it('игнорирует номера вне списка', () => {
    expect(parseVerdictLines('5: да', asked)).toEqual({});
  });

  it('пустой ответ даёт пустой вердикт (вызывающий уйдёт в фолбэк)', () => {
    expect(parseVerdictLines('', asked)).toEqual({});
    expect(parseVerdictLines('не знаю', asked)).toEqual({});
  });
});
