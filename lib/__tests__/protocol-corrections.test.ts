import {
  extractLatestUserCorrections,
  formatChatDraftForPrompt,
} from '../protocol-chat-extract';

const msg = (role: string, text: string) => ({ role, parts: [{ type: 'text', text }] });

describe('extractLatestUserCorrections — что считается правкой', () => {
  it('команда публикации правкой не считается', () => {
    const out = extractLatestUserCorrections([
      msg('user', 'Да, всё верно. Собирай протокол целиком.'),
      msg('assistant', 'Собираю.'),
      msg('user', 'Подтверждаю, формируй протокол в правой панели.'),
    ]);
    expect(out).toEqual([]);
  });

  it('команда публикации С требованием остаётся правкой', () => {
    const out = extractLatestUserCorrections([
      msg('user', 'Собери протокол и замени должность Ирины на директора'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('содержательная правка сохраняется', () => {
    const out = extractLatestUserCorrections([
      msg('user', 'Да, всё верно. Собирай протокол целиком.'),
      msg('assistant', 'Готово.'),
      msg('user', 'В разделе 3 поменяй должность Соколовой Ирины Павловны на «директор по внедрению».'),
    ]);
    expect(out).toEqual([
      'В разделе 3 поменяй должность Соколовой Ирины Павловны на «директор по внедрению».',
    ]);
  });
});

describe('formatChatDraftForPrompt — приоритет последней правки', () => {
  it('последняя правка выносится отдельным блоком до остальных', () => {
    const out = formatChatDraftForPrompt({}, [
      'Протокол №1. Договор №14-ВН от 12.03.2026.',
      'Заказчиком считай компанию Форус.',
      'Поменяй должность Соколовой на «директор по внедрению».',
    ]);
    const currentIdx = out.indexOf('ТЕКУЩАЯ ПРАВКА');
    const backgroundIdx = out.indexOf('Ранее сказанное');
    expect(currentIdx).toBeGreaterThan(-1);
    expect(backgroundIdx).toBeGreaterThan(currentIdx);
    // Сама правка стоит в блоке «текущая», а не в фоне.
    const currentBlock = out.slice(currentIdx, backgroundIdx);
    expect(currentBlock).toContain('директор по внедрению');
    expect(currentBlock).not.toContain('Договор №14-ВН');
  });

  it('единственная правка не тянет за собой пустой блок фона', () => {
    const out = formatChatDraftForPrompt({}, ['Поменяй номер протокола на №7.']);
    expect(out).toContain('ТЕКУЩАЯ ПРАВКА');
    expect(out).not.toContain('Ранее сказанное');
  });

  it('без правок и без драфта возвращает пустую строку', () => {
    expect(formatChatDraftForPrompt({}, [])).toBe('');
  });
});
