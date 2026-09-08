/**
 * Сборка .docx: берём шаблон, подменяем word/document.xml, остальное не трогаем.
 * Про структуру протокола тут не знают — за неё отвечает protocol-body.ts.
 */
import type { Protocol } from '@/lib/schemas/protocol-schema';
import { buildProtocolBodyXml } from './protocol-body';
import { loadTemplateZip } from './template';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const ROOT_OPEN_RX = /<w:document\b[^>]*>/;
const SECT_PR_RX = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/;

/**
 * Корневой элемент со всеми объявлениями namespace и sectPr (поля страницы,
 * ссылки на колонтитулы) берутся из шаблона, а не хардкодятся: при замене
 * шаблона на новую версию они подхватятся сами.
 */
export function assembleDocumentXml(templateXml: string, bodyXml: string): string {
  const rootOpen = templateXml.match(ROOT_OPEN_RX);
  if (!rootOpen) {
    throw new Error('Шаблон протокола повреждён: в word/document.xml нет <w:document>');
  }

  const sectPr = templateXml.match(SECT_PR_RX);
  if (!sectPr) {
    throw new Error('Шаблон протокола повреждён: в word/document.xml нет <w:sectPr>');
  }

  return `${XML_DECLARATION}${rootOpen[0]}<w:body>${bodyXml}${sectPr[0]}</w:body></w:document>`;
}

export async function renderProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const zip = await loadTemplateZip();

  const templateEntry = zip.file('word/document.xml');
  if (!templateEntry) {
    throw new Error('Шаблон протокола повреждён: нет word/document.xml');
  }

  const documentXml = assembleDocumentXml(
    await templateEntry.async('string'),
    buildProtocolBodyXml(protocol),
  );

  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
