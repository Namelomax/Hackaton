import { fixProtocolSectionHeadingsInMarkdown } from '../protocol-markdown-format';

describe('fixProtocolSectionHeadingsInMarkdown', () => {
  // \b в JS не работает после кириллицы (\w — только ASCII), поэтому строки
  // раздела не распознавались вообще: регламент правит именно это (см. A1).
  it('превращает «N. Метка» в «## N. Метка», даже когда после метки сразу кириллица/пунктуация', () => {
    const input = [
      '1. Дата собрания: 12.01.2025',
      '2. Повестка:',
      '4. Содержание встречи:',
      '5. Согласовано:',
    ].join('\n');

    const result = fixProtocolSectionHeadingsInMarkdown(input);

    expect(result).toContain('## 1. Дата собрания: 12.01.2025');
    expect(result).toContain('## 2. Повестка:');
    expect(result).toContain('## 4. Содержание встречи:');
    expect(result).toContain('## 5. Согласовано:');
  });

  it('не трогает строки, уже оформленные как markdown-заголовок', () => {
    const input = '## 3. Участники:';
    expect(fixProtocolSectionHeadingsInMarkdown(input)).toBe(input);
  });
});
