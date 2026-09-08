/** @jest-environment node */
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { assembleDocumentXml, renderProtocolDocx } from '../render';
import { TEMPLATE_PATH } from '../template';
import { SAMPLE_PROTOCOL } from './fixtures';

describe('assembleDocumentXml', () => {
  const templateXml =
    '<?xml version="1.0"?><w:document xmlns:w="urn:w" mc:Ignorable="w14"><w:body>' +
    '<w:p>старое</w:p>' +
    '<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>' +
    '</w:body></w:document>';

  it('переносит корневой элемент и sectPr из шаблона', () => {
    const xml = assembleDocumentXml(templateXml, '<w:p>новое</w:p>');

    expect(xml).toContain('<w:document xmlns:w="urn:w" mc:Ignorable="w14">');
    expect(xml).toContain('<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>');
    expect(xml).toContain('<w:p>новое</w:p>');
    expect(xml).not.toContain('старое');
  });

  it('ставит sectPr последним элементом body', () => {
    const xml = assembleDocumentXml(templateXml, '<w:p>новое</w:p>');
    expect(xml.endsWith('</w:sectPr></w:body></w:document>')).toBe(true);
  });

  it('падает понятной ошибкой на шаблоне без sectPr', () => {
    expect(() =>
      assembleDocumentXml('<w:document><w:body></w:body></w:document>', ''),
    ).toThrow(/sectPr/);
  });

  it('падает понятной ошибкой на шаблоне без <w:document>', () => {
    expect(() =>
      assembleDocumentXml('<w:body><w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:body>', ''),
    ).toThrow(/w:document/);
  });

  it('берёт финальный sectPr, а не вложенный в разрыв раздела', () => {
    const templateWithSectionBreak =
      '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>' +
      '<w:p><w:pPr><w:sectPr><w:pgSz w:w="16838" w:orient="landscape"/></w:sectPr></w:pPr></w:p>' +
      '<w:p>таблица</w:p>' +
      '<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>' +
      '</w:body></w:document>';

    const xml = assembleDocumentXml(templateWithSectionBreak, '<w:p>новое</w:p>');

    expect(xml).toContain('<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>');
    expect(xml).not.toContain('w:orient="landscape"');
  });
});

describe('renderProtocolDocx', () => {
  it('отдаёт валидный zip', async () => {
    const buffer = await renderProtocolDocx(SAMPLE_PROTOCOL);
    const zip = await JSZip.loadAsync(buffer);

    expect(Object.keys(zip.files)).toContain('word/document.xml');
  });

  it('переносит оформление из шаблона байт-в-байт', async () => {
    const source = await JSZip.loadAsync(await readFile(TEMPLATE_PATH));
    const result = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));

    const parts = [
      'word/styles.xml',
      'word/numbering.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/media/image1.png',
      'word/theme/theme1.xml',
    ];

    for (const part of parts) {
      const before = await source.file(part)!.async('nodebuffer');
      const after = await result.file(part)!.async('nodebuffer');
      expect(after.equals(before)).toBe(true);
    }
  });

  it('кладёт данные протокола в document.xml', async () => {
    const zip = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));
    const doc = await zip.file('word/document.xml')!.async('string');

    expect(doc).toContain('ПРОТОКОЛ №7 ОТ 12.01.2025');
    expect(doc).toContain('Иванов И.И.');
    expect(doc).toContain('<w:headerReference');
    expect(doc).toContain('w:top="1424"');
  });

  it('не тащит шрифты в результат', async () => {
    const zip = await JSZip.loadAsync(await renderProtocolDocx(SAMPLE_PROTOCOL));
    expect(Object.keys(zip.files).filter((n) => n.startsWith('word/fonts/'))).toEqual([]);
  });

  it('две параллельные сборки не мешают друг другу', async () => {
    const other = { ...SAMPLE_PROTOCOL, protocolNumber: '№99' };
    const [first, second] = await Promise.all([
      renderProtocolDocx(SAMPLE_PROTOCOL),
      renderProtocolDocx(other),
    ]);

    const read = async (b: Buffer) =>
      (await JSZip.loadAsync(b)).file('word/document.xml')!.async('string');

    expect(await read(first)).toContain('ПРОТОКОЛ №7');
    expect(await read(second)).toContain('ПРОТОКОЛ №99');
  });
});
