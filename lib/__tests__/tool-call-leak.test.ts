import {
  looksLikeTextualToolCall,
  stripToolCallLeak,
  splitStableAndPending,
  filterToolCallLeakStream,
} from '../tool-call-leak';

/** Реальный ответ gemma-4-31b из БД — тот самый, что утёк пользователю в чат. */
const REAL_LEAK =
  '<|tool_call>call:publishInvestigationProtocol{reasonBrief:<|"|>Пользователь попросил изменить должность Соколовой И.П. на «директор по внедрению» и зафиксировать ответственность Грицанюка Н.С. за нагрузочную приёмку.<|"|>}<tool_call|>';

describe('looksLikeTextualToolCall', () => {
  it('ловит реальный утёкший вызов', () => {
    expect(looksLikeTextualToolCall(REAL_LEAK)).toBe(true);
  });

  it('ловит псевдовызов БЕЗ reasonBrief (прежний детектор его пропускал)', () => {
    expect(looksLikeTextualToolCall('<tool_call>{"name":"publish"}</tool_call>')).toBe(true);
    expect(looksLikeTextualToolCall('Сейчас вызову publishInvestigationProtocol')).toBe(true);
  });

  it('ловит прежний вид утечки — аргументы текстом', () => {
    expect(looksLikeTextualToolCall('["reasonBrief": "правка ЦОТ→ЦОД"]')).toBe(true);
  });

  it('не срабатывает на обычном ответе', () => {
    expect(looksLikeTextualToolCall('Собираю протокол в правой панели. Всё верно?')).toBe(false);
    expect(looksLikeTextualToolCall('')).toBe(false);
  });
});

describe('stripToolCallLeak', () => {
  it('вырезает реальный утёкший вызов целиком', () => {
    expect(stripToolCallLeak(REAL_LEAK)).toBe('');
  });

  it('сохраняет нормальный текст вокруг вызова', () => {
    const t = `Обновляю раздел 3. ${REAL_LEAK} Готово?`;
    const out = stripToolCallLeak(t);
    expect(out).toContain('Обновляю раздел 3.');
    expect(out).toContain('Готово?');
    expect(out).not.toContain('reasonBrief');
    expect(out).not.toContain('tool_call');
  });

  it('режет незакрытый вызов до конца текста', () => {
    const out = stripToolCallLeak('Сейчас соберу. <|tool_call>call:publishInvestigationProtocol{');
    expect(out).toBe('Сейчас соберу.');
  });

  it('не трогает текст без разметки', () => {
    expect(stripToolCallLeak('Раздел 3 обновлён.')).toBe('Раздел 3 обновлён.');
  });
});

describe('splitStableAndPending', () => {
  it('стабильная часть не содержит начала маркера', () => {
    const [stable, pending] = splitStableAndPending('Текст до <|tool_call>хвост');
    expect(stable).toBe('Текст до ');
    expect(pending).toBe('<|tool_call>хвост');
  });

  it('без маркеров всё стабильно', () => {
    expect(splitStableAndPending('обычный текст')).toEqual(['обычный текст', '']);
  });
});

/** Прогоняет чанки через фильтр и собирает то, что дошло бы до пользователя. */
async function runFilter(chunks: Array<Record<string, unknown>>): Promise<string> {
  const src = new ReadableStream<Record<string, unknown>>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const out: string[] = [];
  const reader = filterToolCallLeakStream(src).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.type === 'text-delta' && typeof value.delta === 'string') out.push(value.delta);
  }
  return out.join('');
}

describe('filterToolCallLeakStream', () => {
  it('не пропускает утечку, пришедшую одним чанком (режим non-stream у Ollama)', async () => {
    const text = await runFilter([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: REAL_LEAK },
      { type: 'text-end', id: 'a' },
    ]);
    expect(text).toBe('');
  });

  it('не пропускает утечку, разорванную по чанкам посреди маркера', async () => {
    const text = await runFilter([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'Обновляю раздел 3. <|too' },
      { type: 'text-delta', id: 'a', delta: 'l_call>call:publishInvestigationProtocol{reason' },
      { type: 'text-delta', id: 'a', delta: 'Brief:<|"|>причина<|"|>}<tool_call|>' },
      { type: 'text-end', id: 'a' },
    ]);
    // Пробел на стыке — граница отданного префикса, в чате не виден.
    expect(text.trim()).toBe('Обновляю раздел 3.');
    expect(text).not.toContain('tool');
  });

  it('обычный текст доходит целиком и по частям (стриминг не сломан)', async () => {
    const text = await runFilter([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'Собираю ' },
      { type: 'text-delta', id: 'a', delta: 'протокол.' },
      { type: 'text-end', id: 'a' },
    ]);
    expect(text).toBe('Собираю протокол.');
  });

  it('текст после вызова не теряется', async () => {
    const text = await runFilter([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: `Начало. ${REAL_LEAK} Конец.` },
      { type: 'text-end', id: 'a' },
    ]);
    expect(text).toContain('Начало.');
    expect(text).toContain('Конец.');
    expect(text).not.toContain('reasonBrief');
  });

  it('оборванный поток без text-end не теряет хвост', async () => {
    const text = await runFilter([
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'Текст <|неполный маркер' },
    ]);
    expect(text).toContain('Текст');
  });

  it('чанки других типов проходят без изменений', async () => {
    const src = new ReadableStream<Record<string, unknown>>({
      start(c) {
        c.enqueue({ type: 'data-docx', url: 'x' });
        c.close();
      },
    });
    const reader = filterToolCallLeakStream(src).getReader();
    const { value } = await reader.read();
    expect(value).toEqual({ type: 'data-docx', url: 'x' });
  });
});
