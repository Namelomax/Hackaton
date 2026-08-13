import {
  sameWordShape,
  findInflectedCandidates,
  applyInflectionMerge,
  mergeAliases,
  nominativeScore,
} from '../merge-inflected';
import { applyMappingForwardDeep, mergeRemoteResult } from '../merge';
import type { Mapping } from '../types';

/** Прогон «нашли кандидатов → решили без модели». */
function mergeWithoutModel(mapping: Mapping) {
  return applyInflectionMerge(mapping, findInflectedCandidates(mapping), null);
}

describe('sameWordShape — одна словоформа или разные слова', () => {
  it.each([
    ['ирина', 'ирины'],
    ['ирина', 'ириной'],
    ['ирина', 'ирину'],
    ['соколова', 'соколовой'],
    ['сергей', 'сергея'],
    ['форус', 'форуса'],
    ['форус', 'форусом'],
    ['телеграм', 'телеграме'],
    ['татьяна', 'татьяны'],
    ['сбербанк', 'сбербанка'],
    ['иванов', 'иванова'],
  ])('«%s» и «%s» — одна словоформа', (a, b) => {
    expect(sameWordShape(a, b)).toBe(true);
  });

  it.each([
    // Именно на этой паре ломался прежний stem = «первые 4 буквы»: обе давали
    // «алек», и при недоступной модели два разных человека склеивались в одного.
    ['александр', 'алексей'],
    ['мария', 'марина'],
    ['николай', 'никита'],
    ['олег', 'ольга'],
    ['петр', 'петров'],
    ['андрей', 'андреев'],
    ['ржд', 'рст'],
  ])('«%s» и «%s» — разные слова', (a, b) => {
    expect(sameWordShape(a, b)).toBe(false);
  });
});

describe('findInflectedCandidates', () => {
  it('находит падежный дубль ФИО', () => {
    const c = findInflectedCandidates({
      '[PERSON_1]': 'Ирина Соколова',
      '[PERSON_7]': 'Ирины Соколовой',
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ keep: '[PERSON_1]', drop: '[PERSON_7]', partial: false });
  });

  it('ловит частичное упоминание («Ирину» ↔ «Ирина Соколова»)', () => {
    const c = findInflectedCandidates({
      '[PERSON_1]': 'Ирина Соколова',
      '[PERSON_5]': 'Ирину',
    });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ keep: '[PERSON_1]', drop: '[PERSON_5]', partial: true });
  });

  it('не считает кандидатами разных людей с общим началом имени', () => {
    expect(
      findInflectedCandidates({
        '[PERSON_1]': 'Александр Иванов',
        '[PERSON_2]': 'Алексей Иванов',
      }),
    ).toHaveLength(0);
  });

  it('не считает кандидатами однофамильцев с разными именами', () => {
    expect(
      findInflectedCandidates({
        '[PERSON_1]': 'Иванов Пётр',
        '[PERSON_2]': 'Иванова Мария',
      }),
    ).toHaveLength(0);
  });

  it('ловит голое имя, помеченное как LOCATION (реальный случай со стенда)', () => {
    const c = findInflectedCandidates({
      '[LOCATION_1]': 'Никита',
      '[PERSON_2]': 'Грицанюк Никита Сергеевич',
    });
    expect(c).toHaveLength(1);
    // Каноничной остаётся ПЕРСОНА, даже если у локации номер меньше.
    expect(c[0]).toMatchObject({
      keep: '[PERSON_2]',
      drop: '[LOCATION_1]',
      crossLabel: true,
      partial: true,
    });
  });

  it('не сводит многословную ORG с многословной PERSON', () => {
    expect(
      findInflectedCandidates({
        '[PERSON_1]': 'Иванов Пётр Сергеевич',
        '[ORG_1]': 'Иванов Пётр Сергеевич',
      }),
    ).toHaveLength(0);
  });

  it('не трогает метки без падежей (DATE, EMAIL)', () => {
    expect(
      findInflectedCandidates({ '[DATE_1]': '12 мая', '[DATE_2]': '12 мая' }),
    ).toHaveLength(0);
  });

  it('цепочку из трёх форм сводит к самому раннему плейсхолдеру', () => {
    const c = findInflectedCandidates({
      '[PERSON_1]': 'Ирина Соколова',
      '[PERSON_7]': 'Ирины Соколовой',
      '[PERSON_9]': 'Ириной Соколовой',
    });
    expect(c.map((x) => x.keep)).toEqual(['[PERSON_1]', '[PERSON_1]']);
  });
});

describe('applyInflectionMerge — решение без модели осторожное', () => {
  it('склеивает полное ФИО в двух падежах', () => {
    const r = mergeWithoutModel({
      '[PERSON_1]': 'Ирина Соколова',
      '[PERSON_7]': 'Ирины Соколовой',
    });
    expect(Object.keys(r.mapping)).toEqual(['[PERSON_1]']);
    expect(r.aliases).toEqual([{ value: 'Ирины Соколовой', placeholder: '[PERSON_1]' }]);
  });

  it('склеивает организацию из одного слова', () => {
    const r = mergeWithoutModel({ '[ORG_1]': 'Форус', '[ORG_4]': 'Форуса' });
    expect(Object.keys(r.mapping)).toEqual(['[ORG_1]']);
  });

  it('НЕ склеивает одиночные фамилии без модели («Иванов» / «Иванова»)', () => {
    const r = mergeWithoutModel({ '[PERSON_1]': 'Иванов', '[PERSON_2]': 'Иванова' });
    expect(Object.keys(r.mapping)).toHaveLength(2);
  });

  it('НЕ склеивает частичное упоминание без модели', () => {
    const r = mergeWithoutModel({ '[PERSON_1]': 'Ирина Соколова', '[PERSON_5]': 'Ирину' });
    expect(Object.keys(r.mapping)).toHaveLength(2);
  });

  it('склеивает частичное упоминание, если модель подтвердила', () => {
    const mapping = { '[PERSON_1]': 'Ирина Соколова', '[PERSON_5]': 'Ирину' };
    const candidates = findInflectedCandidates(mapping);
    const r = applyInflectionMerge(mapping, candidates, { '[PERSON_5]': true });
    expect(Object.keys(r.mapping)).toEqual(['[PERSON_1]']);
    expect(r.aliases).toEqual([{ value: 'Ирину', placeholder: '[PERSON_1]' }]);
  });

  it('НЕ склеивает разные метки без модели', () => {
    const r = mergeWithoutModel({
      '[LOCATION_1]': 'Никита',
      '[PERSON_2]': 'Грицанюк Никита Сергеевич',
    });
    expect(Object.keys(r.mapping)).toHaveLength(2);
  });

  it('склеивает разные метки, если модель подтвердила', () => {
    const mapping = { '[LOCATION_1]': 'Никита', '[PERSON_2]': 'Грицанюк Никита Сергеевич' };
    const r = applyInflectionMerge(mapping, findInflectedCandidates(mapping), {
      '[LOCATION_1]': true,
    });
    expect(Object.keys(r.mapping)).toEqual(['[PERSON_2]']);
    expect(r.aliases).toEqual([{ value: 'Никита', placeholder: '[PERSON_2]' }]);
  });

  it('вердикт модели «разные» перевешивает эвристику', () => {
    const mapping = { '[PERSON_1]': 'Ирина Соколова', '[PERSON_7]': 'Ирины Соколовой' };
    const r = applyInflectionMerge(mapping, findInflectedCandidates(mapping), {
      '[PERSON_7]': false,
    });
    expect(Object.keys(r.mapping)).toHaveLength(2);
  });

  it('цепочка форм схлопывается в один плейсхолдер', () => {
    const r = mergeWithoutModel({
      '[PERSON_1]': 'Ирина Соколова',
      '[PERSON_7]': 'Ирины Соколовой',
      '[PERSON_9]': 'Ириной Соколовой',
    });
    expect(Object.keys(r.mapping)).toEqual(['[PERSON_1]']);
    expect(r.aliases.every((a) => a.placeholder === '[PERSON_1]')).toBe(true);
  });
});

describe('именительный падеж как каноничное значение', () => {
  it('оценивает именительный выше косвенного', () => {
    expect(nominativeScore('Петров Алексей Иванович')).toBeGreaterThan(
      nominativeScore('Петрова Алексея Ивановича'),
    );
    expect(nominativeScore('Соколова Ирина Павловна')).toBeGreaterThan(
      nominativeScore('Соколовой Ирины Павловны'),
    );
  });

  it('женское ФИО в именительном не считается косвенным', () => {
    expect(nominativeScore('Соколова Ирина Павловна')).toBeGreaterThan(0);
  });

  it('человека, впервые названного в родительном, поправляет на именительный', () => {
    // Реальный случай со стенда: «добавь Петрова Алексея Ивановича» — и в
    // таблице участников фамилия так и осталась в родительном.
    const mapping = {
      '[PERSON_4]': 'Петрова Алексея Ивановича',
      '[PERSON_7]': 'Петров Алексей Иванович',
    };
    const r = applyInflectionMerge(mapping, findInflectedCandidates(mapping), {
      '[PERSON_7]': true,
    });
    // Номер плейсхолдера прежний, значение — каноничное.
    expect(r.mapping['[PERSON_4]']).toBe('Петров Алексей Иванович');
    expect(r.mapping['[PERSON_7]']).toBeUndefined();
    // Старая форма продолжает подставляться — через алиас.
    expect(r.aliases).toEqual([
      { value: 'Петрова Алексея Ивановича', placeholder: '[PERSON_4]' },
    ]);
  });

  it('не портит уже каноничное значение', () => {
    const mapping = {
      '[PERSON_1]': 'Соколова Ирина Павловна',
      '[PERSON_5]': 'Соколовой Ирины Павловны',
    };
    const r = applyInflectionMerge(mapping, findInflectedCandidates(mapping), null);
    expect(r.mapping['[PERSON_1]']).toBe('Соколова Ирина Павловна');
  });
});

describe('алиасы работают дальше по цепочке', () => {
  const mapping = { '[PERSON_1]': 'Ирина Соколова' };
  const aliases = [{ value: 'Ирины Соколовой', placeholder: '[PERSON_1]' }];

  it('склонённая форма подставляется тем же плейсхолдером', () => {
    expect(
      applyMappingForwardDeep('Задача у Ирины Соколовой, поручил Ирина Соколова', mapping, aliases),
    ).toBe('Задача у [PERSON_1], поручил [PERSON_1]');
  });

  it('подстановка уважает границы слова', () => {
    const r = applyMappingForwardDeep('Ирины', mapping, [
      { value: 'Ирин', placeholder: '[PERSON_1]' },
    ]);
    expect(r).toBe('Ирины');
  });

  it('mergeRemoteResult переиспользует плейсхолдер по алиасу, не заводя новый номер', () => {
    const merged = mergeRemoteResult(
      { mapping, counters: { PERSON: 1 }, aliases },
      {
        anonymized_text: 'Поручено [PERSON_1]',
        mapping: { '[PERSON_1]': 'Ирины Соколовой' },
        summary: {},
        spans: [],
      },
    );
    expect(merged.added).toBe(0);
    expect(Object.keys(merged.conversation.mapping)).toEqual(['[PERSON_1]']);
  });

  it('mergeAliases убирает дубли и алиасы мёртвых плейсхолдеров', () => {
    const out = mergeAliases(
      [
        { value: 'Ирины Соколовой', placeholder: '[PERSON_1]' },
        { value: 'Петрова', placeholder: '[PERSON_99]' },
      ],
      [{ value: 'Ирину', placeholder: '[PERSON_1]' }],
      mapping,
    );
    expect(out).toEqual([
      { value: 'Ирины Соколовой', placeholder: '[PERSON_1]' },
      { value: 'Ирину', placeholder: '[PERSON_1]' },
    ]);
  });
});
