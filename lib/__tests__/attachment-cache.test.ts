import {
  attachmentCacheKey,
  getCachedAttachmentText,
  setCachedAttachmentText,
  __clearAttachmentCache,
  __attachmentCacheStats,
} from '../attachment-cache';

const dataUrl = (body: string) => `data:text/plain;base64,${Buffer.from(body).toString('base64')}`;

beforeEach(() => __clearAttachmentCache());

describe('attachmentCacheKey', () => {
  it('одинаковое содержимое — одинаковый ключ', () => {
    const a = { url: dataUrl('расшифровка') };
    const b = { url: dataUrl('расшифровка') };
    expect(attachmentCacheKey(a)).toBe(attachmentCacheKey(b));
  });

  it('разное содержимое — разные ключи', () => {
    expect(attachmentCacheKey({ url: dataUrl('первый') })).not.toBe(
      attachmentCacheKey({ url: dataUrl('второй') }),
    );
  });

  it('имя файла на ключ не влияет — важны только байты', () => {
    const body = dataUrl('одно и то же');
    expect(attachmentCacheKey({ url: body, name: 'a.txt' })).toBe(
      attachmentCacheKey({ url: body, name: 'b.txt' }),
    );
  });

  it('без содержимого ключа нет', () => {
    expect(attachmentCacheKey({})).toBeNull();
    expect(attachmentCacheKey({ url: '' })).toBeNull();
    expect(attachmentCacheKey(null)).toBeNull();
  });

  it('поле data работает наравне с url', () => {
    expect(attachmentCacheKey({ data: dataUrl('x') })).not.toBeNull();
  });
});

describe('кэш', () => {
  it('возвращает сохранённое значение', () => {
    const key = attachmentCacheKey({ url: dataUrl('док') });
    setCachedAttachmentText(key, 'извлечённый текст');
    expect(getCachedAttachmentText(key)).toBe('извлечённый текст');
  });

  it('промах отличается от пустого значения', () => {
    expect(getCachedAttachmentText('нет-такого')).toBeUndefined();
    expect(getCachedAttachmentText(null)).toBeUndefined();
  });

  it('пустой текст не кэшируется — иначе закрепили бы неудачный разбор', () => {
    const key = attachmentCacheKey({ url: dataUrl('док') });
    setCachedAttachmentText(key, '');
    expect(getCachedAttachmentText(key)).toBeUndefined();
  });

  it('вытесняет самые давние при переполнении', () => {
    for (let i = 0; i < 40; i++) {
      setCachedAttachmentText(attachmentCacheKey({ url: dataUrl(`файл ${i}`) }), `текст ${i}`);
    }
    expect(__attachmentCacheStats().entries).toBeLessThanOrEqual(32);
    // Последний записанный на месте, самый первый вытеснен.
    expect(getCachedAttachmentText(attachmentCacheKey({ url: dataUrl('файл 39') }))).toBe('текст 39');
    expect(getCachedAttachmentText(attachmentCacheKey({ url: dataUrl('файл 0') }))).toBeUndefined();
  });

  it('обращение освежает запись и спасает её от вытеснения', () => {
    const first = attachmentCacheKey({ url: dataUrl('важный') });
    setCachedAttachmentText(first, 'нужный текст');
    for (let i = 0; i < 31; i++) {
      setCachedAttachmentText(attachmentCacheKey({ url: dataUrl(`шум ${i}`) }), `t${i}`);
      getCachedAttachmentText(first);
    }
    expect(getCachedAttachmentText(first)).toBe('нужный текст');
  });

  it('повторная запись не задваивает объём', () => {
    const key = attachmentCacheKey({ url: dataUrl('док') });
    setCachedAttachmentText(key, 'аааа');
    setCachedAttachmentText(key, 'бб');
    expect(__attachmentCacheStats()).toEqual({ entries: 1, chars: 2 });
  });
});
