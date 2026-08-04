import { chunkText } from '../chunking';
import {
  AnonymizerUnavailableError,
  buildAnonymizationFromChunks,
  buildAnonymizationFromEntities,
  type GlinerEntity,
} from '../remote-client';

const ent = (
  text: string,
  label: string,
  start: number,
  score = 0.9,
): GlinerEntity => ({ text, label, start, end: start + text.length, score });

describe('buildAnonymizationFromChunks — сборка из покусковых ответов', () => {
  it('offset\'ы кусков переводятся в координаты исходного текста', () => {
    const text = 'Иван приехал\nПётр уехал';
    const chunks = chunkText(text, 800, { group: false });
    expect(chunks).toEqual([
      { offset: 0, chunk: 'Иван приехал' },
      { offset: 13, chunk: 'Пётр уехал' },
    ]);

    // Координаты локальные — как их и отдаёт GLiNER для своего куска.
    const res = buildAnonymizationFromChunks(text, chunks, [
      [ent('Иван', 'person', 0)],
      [ent('Пётр', 'person', 0)],
    ]);

    expect(res.anonymized_text).toBe('[PERSON_1] приехал\n[PERSON_2] уехал');
    expect(res.mapping).toEqual({ '[PERSON_1]': 'Иван', '[PERSON_2]': 'Пётр' });
  });

  it('одна сущность в разных кусках получает ОДИН плейсхолдер', () => {
    const text = 'Иван приехал\nИван уехал';
    const chunks = chunkText(text, 800, { group: false });
    const res = buildAnonymizationFromChunks(text, chunks, [
      [ent('Иван', 'person', 0)],
      [ent('Иван', 'person', 0)],
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1] приехал\n[PERSON_1] уехал');
    expect(res.summary).toEqual({ PERSON: 1 });
  });

  it('падёж ORG в разных кусках схлопывается в один плейсхолдер', () => {
    const text = 'Компания Форус\nдоговор с Форусом';
    const chunks = chunkText(text, 800, { group: false });
    const res = buildAnonymizationFromChunks(text, chunks, [
      [ent('Форус', 'organization', 9)],
      [ent('Форусом', 'organization', 10)],
    ]);
    expect(res.anonymized_text).toBe('Компания [ORG_1]\nдоговор с [ORG_1]');
    // В mapping попадает каноничная (самая короткая) форма.
    expect(res.mapping).toEqual({ '[ORG_1]': 'Форус' });
  });

  it('упавший кусок даёт warning, остальные анонимизируются штатно', () => {
    const text = 'Иван приехал\nПётр уехал';
    const chunks = chunkText(text, 800, { group: false });
    const res = buildAnonymizationFromChunks(text, chunks, [
      [ent('Иван', 'person', 0)],
      new Error('GLiNER вернул HTTP 500'),
    ]);

    expect(res.anonymized_text).toBe('[PERSON_1] приехал\nПётр уехал');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings?.[0]).toMatchObject({
      kind: 'gliner_chunk_failed',
      offset: 13,
      chars: 10,
    });
  });

  it('если упали ВСЕ куски — бросаем, а не отдаём сырой текст как анонимный', () => {
    const text = 'Иван приехал\nПётр уехал';
    const chunks = chunkText(text, 800, { group: false });
    expect(() =>
      buildAnonymizationFromChunks(text, chunks, [
        new Error('HTTP 422'),
        new Error('HTTP 422'),
      ]),
    ).toThrow(AnonymizerUnavailableError);
  });

  it('сущность за границей текста отбрасывается, а не ломает подстановку', () => {
    const text = 'Иван';
    const res = buildAnonymizationFromChunks(text, [{ offset: 0, chunk: text }], [
      [ent('Иван', 'person', 0), { text: '???', label: 'person', start: 90, end: 99, score: 0.9 }],
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1]');
  });
});

describe('идемпотентность: повторная анонимизация не портит плейсхолдеры', () => {
  it('уже существующий [PERSON_1] не заворачивается второй раз', () => {
    const text = '[PERSON_1] приехал';
    const res = buildAnonymizationFromEntities(text, [
      // GLiNER принимает токен плейсхолдера за имя — так и происходит на практике.
      ent('[PERSON_1]', 'person', 0),
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1] приехал');
    expect(res.mapping).toEqual({});
  });
});
