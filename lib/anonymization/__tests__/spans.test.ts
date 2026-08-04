import { rebalanceBounds, resolveOverlaps, type Span } from '../spans';

const span = (start: number, end: number, label: string, text: string, score = 0): Span => ({
  start,
  end,
  label,
  text,
  score,
});

describe('resolveOverlaps — разрешение перекрытий', () => {
  it('вес метки важнее длины: EMAIL(90) побеждает более длинный ORG(62)', () => {
    const kept = resolveOverlaps([
      span(0, 30, 'ORG', 'длинный кусок с почтой внутри'),
      span(10, 25, 'EMAIL', 'a@b.ru'),
    ]);
    expect(kept.map((s) => s.label)).toEqual(['EMAIL']);
  });

  it('при равном весе побеждает более длинный спан', () => {
    const kept = resolveOverlaps([
      span(0, 4, 'PERSON', 'Пётр'),
      span(0, 11, 'PERSON', 'Иванов Пётр'),
    ]);
    expect(kept.map((s) => s.text)).toEqual(['Иванов Пётр']);
  });

  it('score — последний тайбрейк при полном равенстве', () => {
    const kept = resolveOverlaps([
      span(0, 5, 'PERSON', 'Пётр1', 0.3),
      span(0, 5, 'PERSON', 'Пётр2', 0.9),
    ]);
    expect(kept.map((s) => s.text)).toEqual(['Пётр2']);
  });

  it('непересекающиеся спаны сохраняются и сортируются по start', () => {
    const kept = resolveOverlaps([span(20, 25, 'ORG', 'ООО'), span(0, 5, 'PERSON', 'Иван')]);
    expect(kept.map((s) => s.start)).toEqual([0, 20]);
  });

  it('BIK(85) побеждает MILITARY_ID(80) на тех же цифрах', () => {
    const kept = resolveOverlaps([
      span(0, 9, 'MILITARY_ID', '044525225'),
      span(0, 9, 'BIK', '044525225'),
    ]);
    expect(kept.map((s) => s.label)).toEqual(['BIK']);
  });
});

describe('rebalanceBounds — выравнивание непарных кавычек и скобок', () => {
  it('забирает закрывающую «ёлочку», стоящую вплотную снаружи', () => {
    const text = 'Технопарк «Сколково» открыт';
    // Спан захватил открывающую, но не закрывающую.
    expect(rebalanceBounds(text, 10, 19)).toEqual([10, 20]);
  });

  it('пара рядом снаружи важнее выталкивания: «12 -> «12»', () => {
    const text = '«12» сентября';
    const [start, end] = rebalanceBounds(text, 0, 3);
    expect(text.slice(start, end)).toBe('«12»');
  });

  it('выталкивает непарную краевую кавычку, если пары рядом нет', () => {
    const text = '12» сентября';
    const [start, end] = rebalanceBounds(text, 0, 3);
    expect(text.slice(start, end)).toBe('12');
  });

  it('выравнивает скобки: «Альфа-Банк (АО)»', () => {
    const text = 'Альфа-Банк (АО) подтвердил';
    expect(rebalanceBounds(text, 0, 14)).toEqual([0, 15]);
  });

  it('сбалансированный спан не трогается', () => {
    const text = 'ООО «Ромашка» и другие';
    expect(rebalanceBounds(text, 0, 13)).toEqual([0, 13]);
  });

  it('непарная кавычка в СЕРЕДИНЕ спана без пары рядом остаётся как есть', () => {
    const text = 'текст » внутри';
    expect(rebalanceBounds(text, 0, 14)).toEqual([0, 14]);
  });
});
