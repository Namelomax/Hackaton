import { parsePositionOverrides, applyPositionOverrides } from '../protocol-guards';
import type { Protocol } from '@/lib/schemas/protocol-schema';

const protocol = {
  participants: {
    customer: {
      organizationName: 'АО «Ветер»',
      people: [{ fullName: 'Ковалёв Сергей Андреевич', position: 'представитель заказчика' }],
    },
    executor: {
      organizationName: 'Форус',
      people: [
        { fullName: 'Соколова Ирина Павловна', position: 'руководитель отдела внедрения' },
        { fullName: 'Грицанюк Никита Сергеевич', position: 'ведущий инженер' },
      ],
    },
  },
} as unknown as Protocol;

const positionsOf = (p: Protocol) =>
  [...p.participants.customer.people, ...p.participants.executor.people].map(
    (x) => `${x.fullName}: ${x.position}`,
  );

describe('parsePositionOverrides', () => {
  it('разбирает «поменяй должность X на «Y»» (реальная правка со стенда)', () => {
    expect(
      parsePositionOverrides(
        'В разделе 3 поменяй должность Соколовой Ирины Павловны на «директор по внедрению».',
      ),
    ).toEqual([{ name: 'Соколовой Ирины Павловны', position: 'директор по внедрению' }]);
  });

  it('разбирает «Должность X — Y»', () => {
    expect(
      parsePositionOverrides(
        'Должность Ковалёва Сергея Андреевича — начальник департамента эксплуатации.',
      ),
    ).toEqual([
      { name: 'Ковалёва Сергея Андреевича', position: 'начальник департамента эксплуатации' },
    ]);
  });

  it('не срабатывает без слова «должность»', () => {
    expect(parsePositionOverrides('Соколова теперь главная по внедрению')).toEqual([]);
  });

  it('игнорирует упоминание должности без нового значения', () => {
    expect(parsePositionOverrides('Уточни должность Ковалёва')).toEqual([]);
  });
});

describe('applyPositionOverrides', () => {
  it('применяет правку, названную в родительном падеже', () => {
    const { protocol: out, applied } = applyPositionOverrides(protocol, [
      'В разделе 3 поменяй должность Соколовой Ирины Павловны на «директор по внедрению».',
    ]);
    expect(applied).toEqual([
      { name: 'Соколова Ирина Павловна', position: 'директор по внедрению' },
    ]);
    expect(positionsOf(out)).toContain('Соколова Ирина Павловна: директор по внедрению');
    // Остальных не трогаем.
    expect(positionsOf(out)).toContain('Грицанюк Никита Сергеевич: ведущий инженер');
  });

  it('находит человека по части имени', () => {
    const { protocol: out } = applyPositionOverrides(protocol, [
      'Поменяй должность Грицанюка на «архитектор»',
    ]);
    expect(positionsOf(out)).toContain('Грицанюк Никита Сергеевич: архитектор');
  });

  it('не путает однофамильцев с разными именами', () => {
    const { applied } = applyPositionOverrides(protocol, [
      'Должность Соколовой Марии Петровны — бухгалтер',
    ]);
    expect(applied).toEqual([]);
  });

  it('последняя правка перекрывает раннюю', () => {
    const { protocol: out } = applyPositionOverrides(protocol, [
      'Должность Соколовой Ирины Павловны — аналитик',
      'Поменяй должность Соколовой Ирины Павловны на «директор по внедрению»',
    ]);
    expect(positionsOf(out)).toContain('Соколова Ирина Павловна: директор по внедрению');
  });

  it('без правок протокол возвращается как есть', () => {
    const { protocol: out, applied } = applyPositionOverrides(protocol, []);
    expect(out).toBe(protocol);
    expect(applied).toEqual([]);
  });

  it('повторная правка с тем же значением ничего не меняет', () => {
    const { applied } = applyPositionOverrides(protocol, [
      'Должность Грицанюка Никиты Сергеевича — ведущий инженер',
    ]);
    expect(applied).toEqual([]);
  });
});
