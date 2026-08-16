import { normalizeSpelledDates } from '../date-context';

const meeting = new Date(2026, 9, 9); // 09.10.2026

describe('даты, названные словами', () => {
  it('переводит день и месяц в ДД.ММ.ГГГГ, сохраняя предлог', () => {
    const { text } = normalizeSpelledDates(
      'пересобери повреждённую копию до пятнадцатого октября',
      meeting,
    );
    expect(text).toBe('пересобери повреждённую копию до 15.10.2026');
  });

  it('берёт год из даты встречи', () => {
    const { text } = normalizeSpelledDates('перенос назначаем на двадцатое октября', meeting);
    expect(text).toBe('перенос назначаем на 20.10.2026');
  });

  it('месяц далеко позади даты встречи — следующий год', () => {
    // Встреча в декабре, срок «до пятнадцатого февраля» — это февраль 2027.
    const december = new Date(2026, 11, 20);
    const { text } = normalizeSpelledDates('до пятнадцатого февраля', december);
    expect(text).toBe('до 15.02.2027');
  });

  it('составные числительные', () => {
    const { text } = normalizeSpelledDates(
      'до двадцать пятого ноября и тридцать первого декабря',
      meeting,
    );
    expect(text).toBe('до 25.11.2026 и 31.12.2026');
  });

  it('возвращает список замен для показа пользователю', () => {
    const { resolutions } = normalizeSpelledDates('до первого декабря', meeting);
    expect(resolutions).toEqual([{ from: 'первого декабря', to: '01.12.2026' }]);
  });

  it('не трогает то, что датой не является', () => {
    const cases = [
      'третьего дня приходил подрядчик',
      'в первом квартале',
      'договор № А-77 от 20.02.2026 г.',
      'перенос на 20.10.2026',
    ];
    for (const c of cases) {
      expect(normalizeSpelledDates(c, meeting).text).toBe(c);
    }
  });

  it('пустая строка не ломает', () => {
    expect(normalizeSpelledDates('', meeting).text).toBe('');
  });
});
