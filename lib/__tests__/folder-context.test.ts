import { buildFolderContextBlock } from '../folder-context';

describe('buildFolderContextBlock', () => {
  it('без инструкций блока нет', () => {
    expect(buildFolderContextBlock({ name: 'Альфа' })).toBe('');
    expect(buildFolderContextBlock({ name: 'Альфа', instructions: '  ' })).toBe('');
  });

  it('блок строится из одних инструкций, с именем папки', () => {
    const block = buildFolderContextBlock({
      name: 'Альфа',
      instructions: 'Заказчик — АО «Ромашка».',
    });
    expect(block).toContain('Контекст проекта «Альфа»');
    expect(block).toContain('### Инструкции проекта\nЗаказчик — АО «Ромашка».');
    expect(block).not.toContain('Фрагменты источников');
  });

  it('лимит соблюдается, инструкции обрезаются по бюджету', () => {
    const block = buildFolderContextBlock({ name: 'А', instructions: 'и'.repeat(5000) }, 1000);
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).toContain('### Инструкции проекта\nи');
  });

  it('короткие инструкции помещаются целиком', () => {
    const instructions = 'и'.repeat(900);
    const block = buildFolderContextBlock({ name: 'А', instructions }, 1500);
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain(instructions);
  });
});
