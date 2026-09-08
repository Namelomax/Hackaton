/**
 * Готовит бинарный ресурс шаблона протокола из исходника заказчика.
 *
 * Вырезает внедрённые шрифты: в оригинале их семь штук на 4.3 МБ, из-за чего
 * каждый сгенерированный протокол весил бы 2.4 МБ. Verdana и Arial есть на любой
 * Windows-машине, так что вид документа не меняется.
 *
 * Запуск: npm run build:protocol-template
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const SRC = process.argv[2] ?? "Шаблон протокола чистый.docx";
const DST =
  process.argv[3] ?? "lib/docx-template/assets/protocol-template.docx";

const zip = await JSZip.loadAsync(await readFile(SRC));

// Сами файлы шрифтов и связи на них.
for (const name of Object.keys(zip.files)) {
  if (
    name.startsWith("word/fonts/") ||
    name === "word/_rels/fontTable.xml.rels"
  ) {
    zip.remove(name);
  }
}

const patch = async (name, fn) => {
  const entry = zip.file(name);
  if (!entry) return;
  zip.file(name, fn(await entry.async("string")));
};

// Объявление типа .odttf, флаг внедрения и ссылки на шрифты в таблице шрифтов.
await patch("[Content_Types].xml", (s) =>
  s.replace(/<Default[^>]*Extension="odttf"[^>]*\/>/g, ""),
);
await patch("word/settings.xml", (s) =>
  s.replace(/<w:embedTrueTypeFonts\s*\/>/g, ""),
);
await patch("word/fontTable.xml", (s) =>
  s.replace(/<w:embed(?:Regular|Bold|Italic|BoldItalic)\b[^>]*\/>/g, ""),
);

await mkdir(path.dirname(DST), { recursive: true });
await writeFile(
  DST,
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);

console.log(`Шаблон готов: ${DST}`);
