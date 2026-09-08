/**
 * Сборка .docx: берём шаблон, подменяем word/document.xml, остальное не трогаем.
 * Про структуру протокола тут не знают — за неё отвечает protocol-body.ts.
 */
import type { Protocol } from "@/lib/schemas/protocol-schema";
import { buildProtocolBodyXml } from "./protocol-body";
import { loadTemplateZip } from "./template";

const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const ROOT_OPEN_RX = /<w:document\b[^>]*>/;
// В OOXML разрыв раздела в середине документа оформляется вложенным <w:sectPr>
// внутри <w:pPr> абзаца (например, альбомная страница под широкую таблицу).
// Определяющий финальную секцию <w:sectPr> — тот, что идёт последним, прямо
// перед </w:body>. Простой lookahead вида (?=\s*<\/w:body>) здесь не работает:
// при нескольких sectPr в документе ленивый квантификатор [\s\S]*? от ПЕРВОГО
// <w:sectPr> расширяется до тех пор, пока где-то дальше не найдётся
// "</w:sectPr>" перед "</w:body>" — в итоге в захват попадает весь мусор
// между первым и последним sectPr. Поэтому ищем все совпадения через флаг g
// и берём последнее — оно и есть финальный, определяющий sectPr.
const SECT_PR_RX = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/g;

/**
 * Корневой элемент со всеми объявлениями namespace и sectPr (поля страницы,
 * ссылки на колонтитулы) берутся из шаблона, а не хардкодятся: при замене
 * шаблона на новую версию они подхватятся сами.
 *
 * Инвариант: bodyXml приходит из buildProtocolBodyXml и по контракту не
 * содержит собственных <w:sectPr> или <w:body> — иначе разбор сломался бы.
 */
export function assembleDocumentXml(
  templateXml: string,
  bodyXml: string,
): string {
  const rootOpen = templateXml.match(ROOT_OPEN_RX);
  if (!rootOpen) {
    throw new Error(
      "Шаблон протокола повреждён: в word/document.xml нет <w:document>",
    );
  }

  const sectPrMatches = templateXml.match(SECT_PR_RX);
  if (!sectPrMatches) {
    throw new Error(
      "Шаблон протокола повреждён: в word/document.xml нет <w:sectPr>",
    );
  }
  const finalSectPr = sectPrMatches[sectPrMatches.length - 1];

  return `${XML_DECLARATION}${rootOpen[0]}<w:body>${bodyXml}${finalSectPr}</w:body></w:document>`;
}

export async function renderProtocolDocx(protocol: Protocol): Promise<Buffer> {
  const zip = await loadTemplateZip();

  const templateEntry = zip.file("word/document.xml");
  if (!templateEntry) {
    throw new Error("Шаблон протокола повреждён: нет word/document.xml");
  }

  const documentXml = assembleDocumentXml(
    await templateEntry.async("string"),
    buildProtocolBodyXml(protocol),
  );

  zip.file("word/document.xml", documentXml);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
