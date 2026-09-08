import { parseSection1FromUserText } from '@/lib/protocol-user-facts';

describe('parseSection1FromUserText', () => {
  // \w в JS не покрывает кириллицу, поэтому суффикс между "протокол" и номером
  // (падежное окончание вроде "-е") не распознавался вообще — регэксп-фолбэк
  // не находил номер протокола, хотя основной паттерн его тоже не покрывает.
  it('вытаскивает номер протокола, когда между «протокол» и цифрой кириллическое окончание', () => {
    const facts = parseSection1FromUserText('нужен номер протоколе 1');
    expect(facts.protocolNumber).toBe('1');
  });

  it('вытаскивает номер протокола и дату из обычной реплики', () => {
    const facts = parseSection1FromUserText('номер протокола 1, дата 05.04.2026');
    expect(facts.protocolNumber).toBe('1');
    expect(facts.date).toBe('05.04.2026');
  });
});
