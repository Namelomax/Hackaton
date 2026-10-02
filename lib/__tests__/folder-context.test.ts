import { buildFolderContextBlock, folderRagQuery } from '../folder-context';

const longExcerpt = 'Источник: '.padEnd(400, 'а');

describe('buildFolderContextBlock', () => {
  it('без инструкций и источников блока нет', () => {
    expect(buildFolderContextBlock({ name: 'Альфа' })).toBe('');
    expect(buildFolderContextBlock({ name: 'Альфа', instructions: '  ', sourcesExcerpt: 'коротко' })).toBe('');
  });

  it('инструкции и источники попадают в блок с именем папки', () => {
    const block = buildFolderContextBlock({
      name: 'Альфа',
      instructions: 'Заказчик — АО «Ромашка».',
      sourcesExcerpt: longExcerpt,
    });
    expect(block).toContain('Контекст проекта «Альфа»');
    expect(block).toContain('### Инструкции проекта\nЗаказчик — АО «Ромашка».');
    expect(block).toContain('### Фрагменты источников проекта');
    expect(block).toContain(longExcerpt);
  });

  it('короткий фрагмент RAG отбрасывается как шум', () => {
    const block = buildFolderContextBlock({ name: 'А', instructions: 'X', sourcesExcerpt: 'мало' });
    expect(block).not.toContain('Фрагменты источников');
  });

  it('лимит соблюдается, страдают источники, а не инструкции', () => {
    const instructions = 'и'.repeat(900);
    const block = buildFolderContextBlock(
      { name: 'А', instructions, sourcesExcerpt: 'ф'.repeat(5000) },
      1500,
    );
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain(instructions);
    expect(block).toMatch(/ф…\n$/);
  });

  it('если на источники места не осталось, их секции нет', () => {
    const block = buildFolderContextBlock({ name: 'А', instructions: 'и'.repeat(5000), sourcesExcerpt: longExcerpt }, 1000);
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).not.toContain('Фрагменты источников');
  });
});

describe('folderRagQuery', () => {
  it('схлопывает пробелы и обрезает', () => {
    expect(folderRagQuery('  a \n\n b  ')).toBe('a b');
    expect(folderRagQuery('x'.repeat(2000))).toHaveLength(1000);
  });
});
