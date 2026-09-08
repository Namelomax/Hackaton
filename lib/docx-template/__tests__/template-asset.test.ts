/** @jest-environment node */
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const ASSET = path.join(
  process.cwd(),
  "lib/docx-template/assets/protocol-template.docx",
);

describe("ресурс шаблона протокола", () => {
  it("содержит части, отвечающие за фирменное оформление", async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const names = Object.keys(zip.files);

    expect(names).toEqual(
      expect.arrayContaining([
        "word/document.xml",
        "word/styles.xml",
        "word/numbering.xml",
        "word/header1.xml",
        "word/footer1.xml",
        "word/media/image1.png",
        "word/theme/theme1.xml",
      ]),
    );
  });

  it("не тащит внедрённые шрифты", async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const names = Object.keys(zip.files);

    expect(names.filter((n) => n.startsWith("word/fonts/"))).toEqual([]);
    expect(names).not.toContain("word/_rels/fontTable.xml.rels");

    const settings = await zip.file("word/settings.xml")?.async("string");
    expect(settings).not.toContain("embedTrueTypeFonts");
  });

  it("весит меньше 100 КБ", async () => {
    const buffer = await readFile(ASSET);
    expect(buffer.length).toBeLessThan(100 * 1024);
  });

  it("сохраняет ссылки на колонтитулы и поля страницы", async () => {
    const zip = await JSZip.loadAsync(await readFile(ASSET));
    const doc = await zip.file("word/document.xml")?.async("string");

    expect(doc).toContain("<w:headerReference");
    expect(doc).toContain("<w:footerReference");
    expect(doc).toContain('w:top="1424"');
    expect(doc).toContain('w:left="993"');
  });
});
