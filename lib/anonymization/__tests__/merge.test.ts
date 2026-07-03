import { deanonymize } from '../deanonymize';
import { applyMappingForward, applyMappingForwardDeep, mergeRemoteResult, countersFromMapping, labelOf } from '../merge';
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

describe('applyMappingForwardDeep — компоненты ФИО (защита от утечки одиночного имени)', () => {
  const mapping = { '[PERSON_4]': 'Никита Грицанюк', '[ORG_1]': 'группа компаний Форус' };

  it('ловит одиночное имя, когда mapping хранит только полное ФИО', () => {
    const raw = 'На созвоне [PERSON_4], представитель [ORG_1]. Никита, добрый день.';
    const out = applyMappingForwardDeep(raw, mapping);
    expect(out).not.toMatch(/Никита/);
    expect(out).toBe('На созвоне [PERSON_4], представитель [ORG_1]. [PERSON_4], добрый день.');
  });

  it('полное ФИО заменяется целиком (не по кускам)', () => {
    expect(applyMappingForwardDeep('Никита Грицанюк пришёл', mapping)).toBe('[PERSON_4] пришёл');
  });

  it('обычная applyMappingForward одиночное имя НЕ ловит (демонстрация исходного бага)', () => {
    expect(applyMappingForward('Никита, добрый день', mapping)).toBe('Никита, добрый день');
  });

  it('не подставляет компоненты ORG и не режет середину других слов', () => {
    const out = applyMappingForwardDeep('Компания Форус и Никитин', mapping);
    expect(out).toContain('Никитин');
    expect(out).toContain('Форус');
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
    const counters = countersFromMapping(mapping);
    expect(counters.PERSON).toBeGreaterThanOrEqual(20);
    const phs = Object.keys(mapping).slice(0, 30);
    const anonText = phs.join(' / ');
    const real = deanonymize(anonText, mapping);
    for (const ph of phs) expect(real).toContain(mapping[ph]);
    expect(real).not.toMatch(/\[[A-Z_]+_\d+\]/);
  });
});

import { scrubStructured } from '../scrub';

describe('scrubStructured — защитный фильтр', () => {
  it('маскирует email/телефон/длинный ID, пропущенные NER', () => {
    const conv = { mapping: {}, counters: {} };
    const text = 'Контакт ivan@example.com, тел +7 999 123 45 67, ИНН 7707083893.';
    const res = scrubStructured(text, conv);
    expect(res.text).not.toContain('ivan@example.com');
    expect(res.text).not.toMatch(/\+7 999 123 45 67/);
    expect(res.text).not.toContain('7707083893');
    expect(res.text).toMatch(/\[EMAIL_1\]/);
    expect(res.text).toMatch(/\[PHONE_1\]/);
    expect(res.added).toBeGreaterThanOrEqual(3);
    expect(res.conversation.mapping['[EMAIL_1]']).toBe('ivan@example.com');
  });
  it('не трогает плейсхолдеры и обычный текст', () => {
    const conv = { mapping: { '[PERSON_1]': 'Иван' }, counters: { PERSON: 1 } };
    const res = scrubStructured('[PERSON_1] обсудил 3 вопроса за 2 часа.', conv);
    expect(res.text).toBe('[PERSON_1] обсудил 3 вопроса за 2 часа.');
    expect(res.added).toBe(0);
  });
});
