/** @jest-environment node */
import JSZip from "jszip";
import { SAMPLE_PROTOCOL } from "@/lib/docx-template/__tests__/fixtures";
import { protocolToMarkdown } from "@/lib/protocol-markdown-format";
import { POST } from "../route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/download-docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/download-docx", () => {
  it("собирает документ из правленого markdown по шаблону", async () => {
    const response = await POST(
      request({
        markdown: protocolToMarkdown(SAMPLE_PROTOCOL),
        filename: "Протокол.docx",
      }) as never,
    );

    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(
      Buffer.from(await response.arrayBuffer()),
    );
    expect(Object.keys(zip.files)).toContain("word/header1.xml");

    const doc = await zip.file("word/document.xml")?.async("string");
    expect(doc).toContain("ПРОТОКОЛ №7");
  });

  it("отдаёт как есть уже собранный base64", async () => {
    const response = await POST(
      request({
        content: Buffer.from("готовый файл").toString("base64"),
        filename: "Протокол.docx",
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      "готовый файл",
    );
  });

  it("отвергает запрос без содержимого", async () => {
    const response = await POST(
      request({ filename: "Протокол.docx" }) as never,
    );
    expect(response.status).toBe(400);
  });

  it("разбирает старую нумерацию разделов без markdown-заголовков «## N.» (A1+A2.1)", async () => {
    // Легаси-протокол: сервер получал именно такой текст до того, как \b перестал
    // ломать распознавание разделов (см. A1 в отчёте) — секции шли строками
    // «1. Дата собрания: …» без «## ».
    const legacyMarkdown = protocolToMarkdown(SAMPLE_PROTOCOL).replace(
      /^## /gm,
      "",
    );
    expect(legacyMarkdown).not.toContain("##");

    const response = await POST(
      request({
        markdown: legacyMarkdown,
        filename: "Протокол.docx",
      }) as never,
    );

    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(
      Buffer.from(await response.arrayBuffer()),
    );
    const doc = await zip.file("word/document.xml")?.async("string");
    expect(doc).toContain("Иванов И.И.");
    expect(doc).toContain("Версия и дата обновления 1С:БГУ");
  });

  it("возвращает 422, если структура протокола не распозналась на непустом markdown (A2.2)", async () => {
    const unstructuredMarkdown =
      "Просто заметка про встречу, без какой-либо структуры протокола. ".repeat(
        4,
      );
    expect(unstructuredMarkdown.trim().length).toBeGreaterThan(200);

    const response = await POST(
      request({
        markdown: unstructuredMarkdown,
        filename: "Протокол.docx",
      }) as never,
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe("Не удалось разобрать структуру протокола");
  });

  it("отдаёт кириллическое имя файла через filename* (C5)", async () => {
    const response = await POST(
      request({
        content: Buffer.from("готовый файл").toString("base64"),
        filename: "Протокол №7.docx",
      }) as never,
    );

    const disposition = response.headers.get("Content-Disposition") ?? "";

    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("Протокол №7.docx")}`,
    );
    // ASCII-фолбэк filename= не должен содержать кириллицу — её браузер, не
    // понимающий filename*, просто не сможет декодировать.
    expect(disposition).toMatch(/filename="[\x20-\x7E]*"/);
  });
});
