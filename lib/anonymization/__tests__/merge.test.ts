import { deanonymize } from '../deanonymize';
import { applyMappingForward, mergeRemoteResult, countersFromMapping, labelOf } from '../merge';
import type { ConversationMapping } from '../types';
import * as fs from 'fs';
import * as path from 'path';

describe('deanonymize / applyMappingForward', () => {
  const mapping = { '[PERSON_1]': 'Иван Иванов', '[ORG_1]': 'ООО «Чебурашка»' };

  it('подставляет оригиналы по плейсхолдерам', () => {
    expect(deanonymize('[PERSON_1] из [ORG_1]', mapping)).toBe('Иван Иванов из ООО «Чебурашка»');
  });

  it('forward: реальные значения → канонические плейсхолдеры (длинные первыми)', () => {
    const anon = applyMappingForward('Иван Иванов из ООО «Чебурашка» снова Иван Иванов', mapping);
    expect(anon).toBe('[PERSON_1] из [ORG_1] снова [PERSON_1]');
  });

  it('round-trip forward → deanonymize возвращает исходный текст', () => {
    const text = 'Иван Иванов представляет ООО «Чебурашка».';
    expect(deanonymize(applyMappingForward(text, mapping), mapping)).toBe(text);
  });

  it('[PERSON_1] не ломает [PERSON_10] (сортировка по длине)', () => {
    const m = { '[PERSON_1]': 'A', '[PERSON_10]': 'B' };
    expect(deanonymize('[PERSON_10] и [PERSON_1]', m)).toBe('B и A');
  });
});

describe('labelOf', () => {
  it('извлекает метку', () => {
    expect(labelOf('[PERSON_1]')).toBe('PERSON');
    expect(labelOf('[MILITARY_ID_2]')).toBe('MILITARY_ID');
  });
});

describe('mergeRemoteResult — каноническая перенумерация', () => {
  it('переиспользует существующий плейсхолдер и нумерует новые', () => {
    const conv: ConversationMapping = { mapping: { '[PERSON_1]': 'Иван Иванов' }, counters: { PERSON: 1 } };
    const remote = {
      anonymized_text: '[PERSON_1] и [PERSON_2]',
      mapping: { '[PERSON_1]': 'Пётр Петров', '[PERSON_2]': 'Иван Иванов' },
      summary: {},
      spans: [],
    };
    const res = mergeRemoteResult(conv, remote);
    // server [PERSON_2]=Иван Иванов → канонический [PERSON_1]; server [PERSON_1]=Пётр → новый [PERSON_2]
    expect(res.anonymizedText).toBe('[PERSON_2] и [PERSON_1]');
    expect(res.conversation.mapping['[PERSON_1]']).toBe('Иван Иванов');
    expect(res.conversation.mapping['[PERSON_2]']).toBe('Пётр Петров');
    expect(res.added).toBe(1);
  });
});

describe('образец mapping (Чебурашка)', () => {
  const file = path.join(__dirname, 'sample.map.json');
  it('round-trip по реальному mapping', () => {
    if (!fs.existsSync(file)) return;
    const mapping = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
    // counters восстанавливаются корректно
    const counters = countersFromMapping(mapping);
    expect(counters.PERSON).toBeGreaterThanOrEqual(20);
    // соберём текст из части плейсхолдеров и проверим деанонимизацию
    const phs = Object.keys(mapping).slice(0, 30);
    const anonText = phs.join(' / ');
    const real = deanonymize(anonText, mapping);
    for (const ph of phs) expect(real).toContain(mapping[ph]);
    expect(real).not.toMatch(/\[[A-Z_]+_\d+\]/); // не осталось плейсхолдеров
  });
});
