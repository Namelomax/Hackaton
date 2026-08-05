import { buildAnonymizationFromEntities, splitTextIntoChunks } from '../remote-client';

describe('buildAnonymizationFromEntities — сборка результата из сырых GLiNER-сущностей', () => {
  it('базовый случай: person + organization → плейсхолдеры и mapping', () => {
    const text = 'Иванов Пётр из ООО Ромашка';
    const res = buildAnonymizationFromEntities(text, [
      { text: 'Иванов Пётр', label: 'person', start: 0, end: 11, score: 0.9 },
      { text: 'ООО Ромашка', label: 'organization', start: 15, end: 26, score: 0.9 },
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1] из [ORG_1]');
    expect(res.mapping['[PERSON_1]']).toBe('Иванов Пётр');
    expect(res.mapping['[ORG_1]']).toBe('ООО Ромашка');
    expect(res.summary).toEqual({ PERSON: 1, ORG: 1 });
  });

  it('дедуп: два вхождения одного имени получают один плейсхолдер', () => {
    const text = 'Иван приехал. Иван уехал.';
    const res = buildAnonymizationFromEntities(text, [
      { text: 'Иван', label: 'person', start: 0, end: 4, score: 0.8 },
      { text: 'Иван', label: 'person', start: 14, end: 18, score: 0.8 },
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1] приехал. [PERSON_1] уехал.');
    expect(res.mapping).toEqual({ '[PERSON_1]': 'Иван' });
    expect(res.summary).toEqual({ PERSON: 1 });
  });

  it('пересечение спанов: принимается сущность с большим score', () => {
    const text = 'Иванов Пётр';
    const res = buildAnonymizationFromEntities(text, [
      { text: 'Иванов Пётр', label: 'person', start: 0, end: 11, score: 0.9 },
      { text: 'Пётр', label: 'person', start: 7, end: 11, score: 0.5 },
    ]);
    expect(res.anonymized_text).toBe('[PERSON_1]');
    expect(res.mapping).toEqual({ '[PERSON_1]': 'Иванов Пётр' });
  });

  it('метка "phone number" → [PHONE_N], "date" → [DATE_N]', () => {
    const text = '+7 999 123-45-67 и 10.01.2026';
    const res = buildAnonymizationFromEntities(text, [
      { text: '+7 999 123-45-67', label: 'phone number', start: 0, end: 16, score: 0.9 },
      { text: '10.01.2026', label: 'date', start: 19, end: 29, score: 0.9 },
    ]);
    expect(res.anonymized_text).toBe('[PHONE_1] и [DATE_1]');
    expect(res.mapping['[PHONE_1]']).toBe('+7 999 123-45-67');
    expect(res.mapping['[DATE_1]']).toBe('10.01.2026');
  });
});

describe('splitTextIntoChunks — резка текста на куски по границам блоков', () => {
  it('короткий текст (< maxChars) → один кусок с offset 0', () => {
    const text = 'Короткий текст без переносов';
    const chunks = splitTextIntoChunks(text, 1000);
    expect(chunks).toEqual([{ text, offset: 0 }]);
  });

  it('текст с двойным переносом режется по границе абзаца', () => {
    const first = 'А'.repeat(30);
    const second = 'Б'.repeat(30);
    const text = `${first}\n\n${second}`;
    // Окно чуть больше первого абзаца — граница \n\n должна попасть в него.
    const maxChars = first.length + 5;
    const chunks = splitTextIntoChunks(text, maxChars);

    expect(chunks.length).toBe(2);
    expect(chunks[0].offset).toBe(0);
    expect(chunks[0].text).toBe(`${first}\n\n`);
    expect(chunks[1].offset).toBe(chunks[0].text.length);
    expect(chunks[1].text).toBe(second);
    // Конкатенация кусков === исходный текст.
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('offset корректен для всех кусков: text.slice(offset, offset+len) === chunk.text', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Абзац номер ${i}. `.repeat(20));
    const text = paragraphs.join('\n\n');
    const chunks = splitTextIntoChunks(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
    }
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });
});
