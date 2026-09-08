/** @jest-environment node */
import JSZip from 'jszip';
import { SAMPLE_PROTOCOL } from '@/lib/docx-template/__tests__/fixtures';
import { protocolToMarkdown } from '@/lib/protocol-markdown-format';
import { POST } from '../route';

function request(body: unknown): Request {
  return new Request('http://localhost/api/download-docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/download-docx', () => {
  it('собирает документ из правленого markdown по шаблону', async () => {
    const response = await POST(request({
      markdown: protocolToMarkdown(SAMPLE_PROTOCOL),
      filename: 'Протокол.docx',
    }) as never);

    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
    expect(Object.keys(zip.files)).toContain('word/header1.xml');

    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('ПРОТОКОЛ №7');
  });

  it('отдаёт как есть уже собранный base64', async () => {
    const response = await POST(request({
      content: Buffer.from('готовый файл').toString('base64'),
      filename: 'Протокол.docx',
    }) as never);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('готовый файл');
  });

  it('отвергает запрос без содержимого', async () => {
    const response = await POST(request({ filename: 'Протокол.docx' }) as never);
    expect(response.status).toBe(400);
  });
});
