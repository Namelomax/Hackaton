import { cell, esc, paragraph, row, run, table } from "../ooxml";
import { LINE_115, NUM_SECTION, SZ_BODY } from "../style";

describe("esc", () => {
  it("экранирует спецсимволы XML", () => {
    expect(esc("ООО «А&Б» <тест>")).toBe("ООО «А&amp;Б» &lt;тест&gt;");
  });

  it("вырезает управляющие символы, ломающие Word", () => {
    expect(esc("до\u0007после")).toBe("допосле");
  });

  it("вырезает U+FFFE/U+FFFF и одиночные суррогаты — они делают XML невалидным (C1)", () => {
    expect(esc("до\uFFFEпосле")).toBe("допосле");
    expect(esc("до\uFFFFпосле")).toBe("допосле");
    // Одиночный суррогат без пары (например, обрезанный эмодзи).
    expect(esc("до\uD800после")).toBe("допосле");
    expect(esc("до\uDC00после")).toBe("допосле");
  });

  it("не трогает корректные суррогатные пары — эмодзи и предупреждающий знак должны проходить (C1)", () => {
    expect(esc("готово \uD83D\uDE00")).toBe("готово \uD83D\uDE00");
    expect(esc("внимание \u26A0\uFE0F")).toBe("внимание \u26A0\uFE0F");
  });
});

describe("run", () => {
  it("по умолчанию задаёт размер основного текста", () => {
    expect(run("Текст")).toBe(
      `<w:r><w:rPr><w:sz w:val="${SZ_BODY}"/><w:szCs w:val="${SZ_BODY}"/></w:rPr>` +
        `<w:t xml:space="preserve">Текст</w:t></w:r>`,
    );
  });

  it("переносы строк превращает в <w:br/>", () => {
    expect(run("раз\nдва")).toContain(
      '</w:t><w:br/><w:t xml:space="preserve">два</w:t>',
    );
  });

  it("складывает жирный, курсив и подчёркивание в правильном порядке", () => {
    expect(run("X", { bold: true, italic: true, underline: true })).toContain(
      '<w:b/><w:i/><w:u w:val="single"/>',
    );
  });
});

describe("paragraph", () => {
  it("без свойств не выводит пустой pPr", () => {
    expect(paragraph("")).toBe("<w:p></w:p>");
  });

  it("соблюдает порядок numPr → spacing → ind → jc", () => {
    const xml = paragraph("", {
      align: "center",
      indentLeft: 284,
      indentHanging: 284,
      spacingLine: LINE_115,
      numId: NUM_SECTION,
    });

    expect(xml).toBe(
      "<w:p><w:pPr>" +
        `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${NUM_SECTION}"/></w:numPr>` +
        `<w:spacing w:line="${LINE_115}" w:lineRule="auto"/>` +
        '<w:ind w:left="284" w:hanging="284"/>' +
        '<w:jc w:val="center"/>' +
        "</w:pPr></w:p>",
    );
  });
});

describe("table", () => {
  it("строит tblPr в порядке tblW → tblInd → tblBorders → tblLayout → tblLook", () => {
    const xml = table(row(cell(paragraph(""), { width: 100 })), {
      grid: [100],
      width: 100,
      borders: "single",
    });

    expect(xml.indexOf("<w:tblW")).toBeLessThan(xml.indexOf("<w:tblInd"));
    expect(xml.indexOf("<w:tblInd")).toBeLessThan(xml.indexOf("<w:tblBorders"));
    expect(xml.indexOf("<w:tblBorders")).toBeLessThan(
      xml.indexOf("<w:tblLayout"),
    );
    expect(xml).toContain('<w:gridCol w:w="100"/>');
  });
});

describe("cell", () => {
  it('borders="none" гасит все четыре границы', () => {
    expect(cell(paragraph(""), { width: 100, borders: "none" })).toContain(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
  });

  it('borders="bottom" оставляет нижнюю границу — это линия подписи', () => {
    const xml = cell(paragraph(""), { width: 100, borders: "bottom" });

    expect(xml).toContain(
      '<w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>',
    );
    expect(xml).not.toContain('<w:bottom w:val="nil"/>');
  });

  it("пустая ячейка всё равно содержит абзац — иначе Word не открывает файл", () => {
    expect(cell("", { width: 100 })).toContain("<w:p></w:p>");
  });

  it("gridSpan идёт после tcW", () => {
    const xml = cell(paragraph(""), { width: 200, gridSpan: 2 });
    expect(xml.indexOf("<w:tcW")).toBeLessThan(xml.indexOf("<w:gridSpan"));
  });
});
