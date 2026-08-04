import { chunkText } from '../chunking';

describe('chunkText — резка с сохранением offset\'ов', () => {
  it('главный инвариант: text.slice(offset, offset+len) === chunk', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Строка номер ${i} с текстом`).join('\n');
    for (const group of [true, false]) {
      for (const { offset, chunk } of chunkText(text, 80, { group })) {
        expect(text.slice(offset, offset + chunk.length)).toBe(chunk);
      }
    }
  });

  it('group=false: по одной строке на кусок', () => {
    const text = 'первая\nвторая\nтретья';
    expect(chunkText(text, 800, { group: false })).toEqual([
      { offset: 0, chunk: 'первая' },
      { offset: 7, chunk: 'вторая' },
      { offset: 14, chunk: 'третья' },
    ]);
  });

  it('group=true: подряд идущие строки пакуются вместе', () => {
    const text = 'аб\nвг\nде';
    expect(chunkText(text, 800, { group: true })).toEqual([{ offset: 0, chunk: 'аб\nвг\nде' }]);
  });

  it('слишком длинная строка режется по пробелу, offset\'ы остаются точными', () => {
    const text = 'слово '.repeat(50).trim();
    const chunks = chunkText(text, 40, { group: false });
    expect(chunks.length).toBeGreaterThan(1);
    for (const { offset, chunk } of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      expect(text.slice(offset, offset + chunk.length)).toBe(chunk);
    }
  });

  it('строка без пробелов длиннее лимита режется жёстко и не зацикливается', () => {
    const text = 'ы'.repeat(100);
    const chunks = chunkText(text, 30, { group: false });
    expect(chunks.map((c) => c.chunk.length)).toEqual([30, 30, 30, 10]);
    expect(chunks.map((c) => c.offset)).toEqual([0, 30, 60, 90]);
  });

  it('пустые строки и пустой текст отбрасываются', () => {
    expect(chunkText('', 800)).toEqual([]);
    expect(chunkText('\n\n   \n', 800, { group: false })).toEqual([]);
  });

  it('документ больше лимита GLiNER режется на куски по 800 символов', () => {
    // Ровно тот случай, на котором прод падал с HTTP 422.
    const text = Array.from({ length: 2000 }, (_, i) => `Реплика ${i}: какой-то текст`).join('\n');
    expect(text.length).toBeGreaterThan(50_000);
    const chunks = chunkText(text, 800, { group: false });
    for (const { chunk } of chunks) expect(chunk.length).toBeLessThanOrEqual(800);
  });
});
