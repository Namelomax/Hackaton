import {
  buildTitleSource,
  fallbackTitleFromSource,
  sanitizeGeneratedTitle,
  TITLE_MAX_LENGTH,
} from '../chat-title';
import { SGR_CHAT_TITLE_PROMPT } from '../prompts/sgr-prompts';

describe('sanitizeGeneratedTitle', () => {
  it('вырезает <think>…</think> и берёт то, что после', () => {
    const raw = '<think>Пользователь прислал расшифровку. Тема — охлаждение.</think>\nПриёмка узла охлаждения';
    expect(sanitizeGeneratedTitle(raw)).toBe('Приёмка узла охлаждения');
  });

  it('вырезает незакрытый <think> — модель обрывается по лимиту токенов', () => {
    expect(sanitizeGeneratedTitle('<think>размышляю и не успел закрыть тег')).toBeNull();
  });

  it('снимает кавычки-ёлочки и служебный префикс', () => {
    expect(sanitizeGeneratedTitle('Название: «Перенос сроков поставки»')).toBe('Перенос сроков поставки');
    expect(sanitizeGeneratedTitle('Тема: "Бюджет на 2027 год"')).toBe('Бюджет на 2027 год');
    expect(sanitizeGeneratedTitle('Заголовок: Ремонт кровли')).toBe('Ремонт кровли');
  });

  it('из многострочного ответа берёт только первую значимую строку', () => {
    expect(sanitizeGeneratedTitle('\n\nСогласование сметы\nЭто название отражает тему.')).toBe(
      'Согласование сметы',
    );
  });

  it('снимает точку в конце, но сохраняет вопросительный знак', () => {
    expect(sanitizeGeneratedTitle('Обсуждение графика.')).toBe('Обсуждение графика');
    expect(sanitizeGeneratedTitle('Кто отвечает за приёмку?')).toBe('Кто отвечает за приёмку?');
  });

  it('схлопывает лишние пробелы', () => {
    expect(sanitizeGeneratedTitle('Приёмка    узла   охлаждения')).toBe('Приёмка узла охлаждения');
  });

  it('обрезает длинный ответ по границе слова, итог не длиннее лимита', () => {
    const long =
      'Совещание по вопросам организации приёмки оборудования системы охлаждения главного корпуса';
    const result = sanitizeGeneratedTitle(long)!;
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(result.endsWith('…')).toBe(true);
    // Резать нужно по границе слова. Проверяем именно это: отбросив
    // многоточие, получаем префикс оригинала, за которым в оригинале идёт
    // пробел. (Проверять «последний символ не буква» бессмысленно — при
    // корректной резке там как раз буква, последняя буква целого слова.)
    const withoutEllipsis = result.slice(0, -1);
    expect(long.startsWith(withoutEllipsis)).toBe(true);
    expect(long[withoutEllipsis.length]).toBe(' ');
  });

  it('возвращает null на пустом и на дефолтном заголовке', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull();
    expect(sanitizeGeneratedTitle(null)).toBeNull();
    expect(sanitizeGeneratedTitle('   ')).toBeNull();
    expect(sanitizeGeneratedTitle('Чат')).toBeNull();
    expect(sanitizeGeneratedTitle('чат')).toBeNull();
    expect(sanitizeGeneratedTitle('Новый чат 3')).toBeNull();
    expect(sanitizeGeneratedTitle('New conversation')).toBeNull();
  });

  it('возвращает null на слишком коротком ответе', () => {
    expect(sanitizeGeneratedTitle('ок')).toBeNull();
  });

  it('РЕГРЕССИЯ: кириллица не теряется — \\w и \\b в JS работают по ASCII', () => {
    // Санитайзер, написанный на \w/\b, на этой строке вернул бы пустоту.
    expect(sanitizeGeneratedTitle('Ёлочные закупки')).toBe('Ёлочные закупки');
  });
});

describe('buildTitleSource', () => {
  it('ставит текст сообщения перед текстом вложений', () => {
    const source = buildTitleSource('составь протокол', ['СТЕНОГРАММА\nо приёмке']);
    expect(source.indexOf('составь протокол')).toBeLessThan(source.indexOf('СТЕНОГРАММА'));
  });

  it('пропускает пустые и null-вложения', () => {
    expect(buildTitleSource('текст', [null, '', '   ', 'файл'])).toBe('текст\n\nфайл');
  });

  it('режет хвост, а не начало — шапка расшифровки всегда сверху', () => {
    const head = 'ТЕМА СОВЕЩАНИЯ: приёмка';
    const source = buildTitleSource(head, ['x'.repeat(10_000)], 100);
    expect(source.length).toBe(100);
    expect(source.startsWith(head)).toBe(true);
  });

  it('на пустом входе возвращает пустую строку', () => {
    expect(buildTitleSource(null, [])).toBe('');
    expect(buildTitleSource(undefined, [null])).toBe('');
  });
});

describe('fallbackTitleFromSource', () => {
  it('берёт первую значимую строку', () => {
    expect(fallbackTitleFromSource('\n\nСовещание по бюджету\nИванов: добрый день')).toBe(
      'Совещание по бюджету',
    );
  });

  it('возвращает null на пустом исходнике', () => {
    expect(fallbackTitleFromSource('')).toBeNull();
    expect(fallbackTitleFromSource('   \n  \n')).toBeNull();
  });

  it('длинную первую строку обрезает как обычный заголовок', () => {
    const source =
      'Совещание по вопросам организации приёмки оборудования системы охлаждения главного корпуса';
    const result = fallbackTitleFromSource(source)!;
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });
});

describe('SGR_CHAT_TITLE_PROMPT', () => {
  it('содержит плейсхолдер {{SOURCE}} — иначе исходник не подставится', () => {
    expect(SGR_CHAT_TITLE_PROMPT).toContain('{{SOURCE}}');
  });
});
