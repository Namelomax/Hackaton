import { expandTableRowEdits, applyEditsToProtocol } from '../protocol-patch';
import type { Protocol } from '@/lib/schemas/protocol-schema';

describe('expandTableRowEdits', () => {
  it('РЕГРЕССИЯ: строка таблицы со стенда разбирается на изменившуюся ячейку', () => {
    // Ровно то, что вернула модель и что не нашлось в JSON:
    // планировщик видит markdown, а замены применяются к полям Protocol.
    const out = expandTableRowEdits([
      {
        find: 'Ковалёв Сергей Андреевич | начальник департамента эксплуатации',
        replace: 'Ковалёв Сергей Андреевич | технический директор',
      },
    ]);
    expect(out).toEqual([
      { find: 'начальник департамента эксплуатации', replace: 'технический директор' },
    ]);
  });

  it('снимает ведущий и хвостовой «|» markdown-строки', () => {
    const out = expandTableRowEdits([
      { find: '| Иванов И.И. | инженер |', replace: '| Иванов И.И. | архитектор |' },
    ]);
    expect(out).toEqual([{ find: 'инженер', replace: 'архитектор' }]);
  });

  it('изменились ОБЕ ячейки — не разбираем: модель метит не в ту строку', () => {
    // Именно так выглядит ошибка планировщика, из-за которой должность
    // применилась к другому участнику, затерев его собственную.
    const edits = [{ find: 'Петров П.П. | инженер', replace: 'Сидоров С.С. | архитектор' }];
    expect(expandTableRowEdits(edits)).toEqual(edits);
  });

  it('обычные замены не трогает', () => {
    const edits = [{ find: 'Срок: требует уточнения', replace: 'Срок: 10.09.2026' }];
    expect(expandTableRowEdits(edits)).toEqual(edits);
  });

  it('разное число ячеек — отдаёт как есть, пусть работают прежние подстраховки', () => {
    const edits = [{ find: 'а | б | в', replace: 'а | б' }];
    expect(expandTableRowEdits(edits)).toEqual(edits);
  });

  it('«|» только с одной стороны — спарить нечего, отдаёт как есть', () => {
    const edits = [{ find: 'Иванов | инженер', replace: 'архитектор' }];
    expect(expandTableRowEdits(edits)).toEqual(edits);
  });

  it('ячейки не изменились — отдаёт как есть', () => {
    const edits = [{ find: 'Иванов | инженер', replace: 'Иванов | инженер' }];
    expect(expandTableRowEdits(edits)).toEqual(edits);
  });
});

describe('applyEditsToProtocol со строкой таблицы', () => {
  const protocol = {
    meetingDate: '03.09.2026',
    participants: {
      customer: {
        organizationName: 'ООО «СеверГаз»',
        people: [
          { fullName: 'Ковалёв Сергей Андреевич', position: 'начальник департамента эксплуатации' },
        ],
      },
      executor: { organizationName: 'АО «ИНФОЛАЙН»', people: [] },
    },
    meetingContent: { topics: [], summary: [] },
  } as unknown as Protocol;

  it('правка строкой таблицы теперь применяется, а не уходит в полную генерацию', () => {
    const res = applyEditsToProtocol(protocol, [
      {
        find: 'Ковалёв Сергей Андреевич | начальник департамента эксплуатации',
        replace: 'Ковалёв Сергей Андреевич | технический директор',
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.protocol.participants.customer.people[0].position).toBe('технический директор');
      // ФИО не тронуто — менялась только одна ячейка.
      expect(res.protocol.participants.customer.people[0].fullName).toBe('Ковалёв Сергей Андреевич');
    }
  });
});

/**
 * Ради этого патч и выключали: правка молча ложилась не в тот пункт.
 * Пользователь видел «правка внесена», а изменился соседний срок.
 */
describe('неоднозначный фрагмент не применяется к первому вхождению', () => {
  const threeTopics = {
    meetingDate: '09.10.2026',
    participants: {
      customer: { organizationName: 'ООО «Меридиан»', people: [] },
      executor: { organizationName: '', people: [] },
    },
    meetingContent: {
      topics: [
        { title: 'Копии', listened: '', discussed: '', decided: 'Срок: подлежит уточнению.' },
        { title: 'Перенос', listened: '', discussed: '', decided: 'Срок: подлежит уточнению.' },
        { title: 'Откат', listened: '', discussed: '', decided: 'Срок: подлежит уточнению.' },
      ],
      summary: [],
    },
  } as unknown as Protocol;

  it('замена пропускается и помечается как AMBIGUOUS, документ не меняется', () => {
    const res = applyEditsToProtocol(threeTopics, [
      { find: 'Срок: подлежит уточнению.', replace: 'Срок: 20.10.2026.' },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.applied).toHaveLength(0);
      expect(res.warnings.some((w) => w.startsWith('AMBIGUOUS:'))).toBe(true);
      // Ни один из трёх пунктов не тронут.
      for (const t of res.protocol.meetingContent.topics) {
        expect(t.decided).toBe('Срок: подлежит уточнению.');
      }
    }
  });

  it('с достаточным окружением та же правка применяется ровно в нужный пункт', () => {
    const withContext = {
      ...threeTopics,
      meetingContent: {
        topics: [
          { title: 'Копии', listened: '', discussed: '', decided: 'Восстановление копии. Срок: подлежит уточнению.' },
          { title: 'Перенос', listened: '', discussed: '', decided: 'Перенос базы. Срок: подлежит уточнению.' },
        ],
        summary: [],
      },
    } as unknown as Protocol;

    const res = applyEditsToProtocol(withContext, [
      { find: 'Перенос базы. Срок: подлежит уточнению.', replace: 'Перенос базы. Срок: 20.10.2026.' },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.applied).toHaveLength(1);
      expect(res.protocol.meetingContent.topics[0].decided).toBe(
        'Восстановление копии. Срок: подлежит уточнению.',
      );
      expect(res.protocol.meetingContent.topics[1].decided).toBe('Перенос базы. Срок: 20.10.2026.');
    }
  });

  it('ненайденный фрагмент помечается NOTFOUND — для второй попытки планировщика', () => {
    const res = applyEditsToProtocol(threeTopics, [
      { find: 'такой фразы в протоколе нет совсем', replace: 'что угодно' },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.applied).toHaveLength(0);
      expect(res.warnings.some((w) => w.startsWith('NOTFOUND:'))).toBe(true);
    }
  });
});

/**
 * «Решили» и его зеркало в «Резюме» — одно решение в двух полях. Правка обязана
 * лечь в оба, иначе в резюме остаётся старый срок.
 */
describe('дублирование «Решили» ↔ «Резюме»', () => {
  const mirrored = {
    meetingDate: '09.10.2026',
    participants: {
      customer: { organizationName: 'ООО «Меридиан»', people: [] },
      executor: { organizationName: '', people: [] },
    },
    meetingContent: {
      topics: [
        { title: 'Откат', listened: '', discussed: '', decided: 'Заказчик подготовит регламент отката. Срок: требует уточнения.' },
      ],
      summary: [
        { question: 'Откат', decision: 'Заказчик подготовит регламент отката. Срок: требует уточнения.' },
      ],
    },
  } as unknown as Protocol;

  it('РЕГРЕССИЯ: два вхождения в decided и summary меняются ОБА, а не пропускаются', () => {
    const res = applyEditsToProtocol(mirrored, [
      {
        find: 'Заказчик подготовит регламент отката. Срок: требует уточнения.',
        replace: 'Заказчик подготовит регламент отката. Срок: 18.10.2026.',
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.applied).toHaveLength(1);
      expect(res.protocol.meetingContent.topics[0].decided).toContain('18.10.2026');
      expect(res.protocol.meetingContent.summary[0].decision).toContain('18.10.2026');
      expect(res.warnings.some((w) => w.startsWith('AMBIGUOUS:'))).toBe(false);
    }
  });

  it('markdown-разметка в find снимается: <br> и ** в полях JSON не существует', () => {
    const res = applyEditsToProtocol(mirrored, [
      {
        find: 'Заказчик подготовит регламент отката.<br>**Срок:** требует уточнения.',
        replace: 'Заказчик подготовит регламент отката. Срок: 18.10.2026.',
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.applied).toHaveLength(1);
  });
});
