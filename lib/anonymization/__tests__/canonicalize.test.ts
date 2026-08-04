import { canonicalizeEntities, groupKey, wordStem } from '../canonicalize';
import type { Span } from '../spans';

const span = (label: string, text: string, start = 0): Span => ({
  start,
  end: start + text.length,
  label,
  text,
});

describe('wordStem / groupKey — основа слова', () => {
  it('снимает падежное окончание', () => {
    expect(wordStem('Форуса')).toBe('форус');
    expect(wordStem('Форус')).toBe('форус');
    expect(wordStem('Телеграме')).toBe('телеграм');
  });

  it('не режет основу короче трёх символов', () => {
    expect(wordStem('оба')).toBe('оба');
  });

  it('краевые кавычки и пунктуация не влияют на ключ', () => {
    expect(groupKey('«КиберКубок 2025»')).toBe(groupKey('КиберКубок 2025'));
  });

  it('длинное окончание снимается раньше короткого', () => {
    expect(wordStem('связями')).toBe('связ');
  });
});

describe('canonicalizeEntities — схлопывание падежных вариантов', () => {
  it('ORG в разных падежах получает общий mergeKey и самую короткую форму', () => {
    const out = canonicalizeEntities([span('ORG', 'Форус'), span('ORG', 'Форуса', 10)]);
    expect(out[0].mergeKey).toBe(out[1].mergeKey);
    expect(out[0].canonicalText).toBe('Форус');
    expect(out[1].canonicalText).toBe('Форус');
  });

  it('ORG и LOCATION с одной основой схлопываются в один плейсхолдер', () => {
    const out = canonicalizeEntities([span('ORG', 'Телеграме'), span('LOCATION', 'Телеграм', 20)]);
    expect(out[0].mergeKey).toBe(out[1].mergeKey);
  });

  it('PERSON НЕ схлопывается: Иванов и Иванова — разные люди', () => {
    const out = canonicalizeEntities([span('PERSON', 'Иванов'), span('PERSON', 'Иванова', 10)]);
    expect(out[0].mergeKey).toBeUndefined();
    expect(out[1].mergeKey).toBeUndefined();
  });

  it('уже проставленный mergeKey не перетирается', () => {
    const preset: Span = { ...span('ORG', 'Форуса'), mergeKey: 'REVIEW_DECISION' };
    const out = canonicalizeEntities([preset]);
    expect(out[0].mergeKey).toBe('REVIEW_DECISION');
  });

  it('результат детерминирован независимо от порядка спанов', () => {
    const a = canonicalizeEntities([span('ORG', 'Форусом'), span('ORG', 'Форус', 10)]);
    const b = canonicalizeEntities([span('ORG', 'Форус'), span('ORG', 'Форусом', 10)]);
    expect(a[0].canonicalText).toBe('Форус');
    expect(b[0].canonicalText).toBe('Форус');
  });
});
