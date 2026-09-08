/** @jest-environment node */
import JSZip from 'jszip';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { generateProtocolDocx } from '../docx-generator';

describe('generateProtocolDocx', () => {
  it('собирает документ по корпоративному шаблону', async () => {
    const zip = await JSZip.loadAsync(await generateProtocolDocx(SAMPLE_PROTOCOL));

    // Колонтитулы с логотипом и реквизитами появились только после перехода на шаблон.
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['word/header1.xml', 'word/footer1.xml', 'word/media/image1.png']),
    );
  });

  it('больше не заливает шапки таблиц серым', async () => {
    const zip = await JSZip.loadAsync(await generateProtocolDocx(SAMPLE_PROTOCOL));
    const doc = await zip.file('word/document.xml')!.async('string');

    expect(doc).not.toContain('D9D9D9');
  });
});
