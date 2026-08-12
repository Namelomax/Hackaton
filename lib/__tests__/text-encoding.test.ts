import { decodeTextBytes, textReadabilityScore } from '../text-encoding';

/** Кодирует строку в windows-1251 вручную — TextEncoder умеет только UTF-8. */
function toCp1251(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c < 0x80) out[i] = c;
    else if (c === 0x401) out[i] = 0xa8; // Ё
    else if (c === 0x451) out[i] = 0xb8; // ё
    else if (c >= 0x410 && c <= 0x44f) out[i] = c - 0x410 + 0xc0; // А..я
    else if (c === 0x2014) out[i] = 0x97; // —
    else if (c === 0xab) out[i] = 0xab;
    else out[i] = 0x3f; // ?
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Типичная строка расшифровки: ФИО, телефон, почта. */
const SAMPLE = 'Соколова Ирина Павловна, тел. +7 999 123-45-67, ирина@forus.ru';

describe('decodeTextBytes', () => {
  it('читает UTF-8', () => {
    expect(decodeTextBytes(utf8(SAMPLE))).toBe(SAMPLE);
  });

  it('снимает UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(SAMPLE)]);
    expect(decodeTextBytes(withBom)).toBe(SAMPLE);
  });

  it('читает UTF-16LE по BOM', () => {
    const body = SAMPLE;
    const bytes = new Uint8Array(2 + body.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      bytes[2 + i * 2] = c & 0xff;
      bytes[2 + i * 2 + 1] = c >> 8;
    }
    expect(decodeTextBytes(bytes)).toBe(body);
  });

  it('РЕГРЕССИЯ: windows-1251 читается как кириллица, а не как мойибаке', () => {
    const decoded = decodeTextBytes(toCp1251(SAMPLE));
    expect(decoded).toBe(SAMPLE);
    // Именно из-за этого утекали ПДн: в мойибаке фамилия неразличима.
    expect(decoded).toContain('Соколова');
    expect(decoded).toContain('+7 999 123-45-67');
  });

  it('cp1251 без детектора выглядел бы читаемым, но кириллицы в нём нет', () => {
    // Так делал старый код: buf.toString('utf8').
    const naive = new TextDecoder('utf-8').decode(toCp1251(SAMPLE));
    expect(naive).not.toContain('Соколова');
    expect(textReadabilityScore(naive)).toBeLessThan(
      textReadabilityScore(decodeTextBytes(toCp1251(SAMPLE))!),
    );
  });

  it('пустой ввод — null', () => {
    expect(decodeTextBytes(new Uint8Array(0))).toBeNull();
    expect(decodeTextBytes(null)).toBeNull();
  });

  it('чистый ASCII не портится', () => {
    const ascii = 'Contract No. 14-VN dated 12.03.2026';
    expect(decodeTextBytes(utf8(ascii))).toBe(ascii);
  });
});

describe('textReadabilityScore', () => {
  it('кириллица ценится выше мойибаке', () => {
    expect(textReadabilityScore('Совещание состоялось')).toBeGreaterThan(
      textReadabilityScore('Ñîâåùàíèå ñîñòîÿëîñü'),
    );
  });

  it('символы замены штрафуются', () => {
    expect(textReadabilityScore('текст')).toBeGreaterThan(textReadabilityScore('�����'));
  });

  it('пустая строка — -1', () => {
    expect(textReadabilityScore('')).toBe(-1);
  });
});
