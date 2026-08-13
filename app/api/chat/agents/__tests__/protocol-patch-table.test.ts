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

  it('несколько изменившихся ячеек дают несколько замен', () => {
    const out = expandTableRowEdits([
      { find: 'Петров П.П. | инженер', replace: 'Сидоров С.С. | архитектор' },
    ]);
    expect(out).toEqual([
      { find: 'Петров П.П.', replace: 'Сидоров С.С.' },
      { find: 'инженер', replace: 'архитектор' },
    ]);
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
