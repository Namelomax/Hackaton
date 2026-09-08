import { type NextRequest, NextResponse } from "next/server";
import { generateProtocolDocx } from "@/lib/docx-generator";
import { markdownToProtocol } from "@/lib/protocol-markdown-parse";

/**
 * Отдаёт .docx протокола.
 *
 * Обычный путь: клиент присылает base64 файла, который сервер уже собрал по
 * шаблону во время генерации, — просто отдаём его.
 *
 * После ручной правки в панели готового файла нет: клиент присылает markdown,
 * и мы пересобираем документ из него, снова по шаблону. Сборка на клиенте
 * убрана намеренно — иначе правленый протокол выходил бы с другим оформлением.
 */
export async function POST(request: NextRequest) {
  try {
    const { content, markdown, filename } = await request.json();

    if (!filename || (!content && !markdown)) {
      return NextResponse.json(
        { error: "Missing content or filename" },
        { status: 400 },
      );
    }

    let buffer: Buffer;

    if (content) {
      buffer = Buffer.from(content, "base64");
    } else {
      const protocol = markdownToProtocol(markdown);

      // Если разбор дал пустой каркас на непустом (не коротком) входе — это не
      // «пользователь написал мало», а маркер того, что markdownToProtocol не
      // распознал структуру. Раньше в этом случае молча уходил .docx с одним
      // скелетом раздела 1 и без единого слова пользователя (см. A2 в отчёте).
      const isStructureEmpty =
        protocol.agenda.items.length === 0 &&
        protocol.participants.customer.people.length === 0 &&
        protocol.participants.executor.people.length === 0 &&
        protocol.meetingContent.topics.length === 0 &&
        protocol.meetingContent.summary.length === 0;

      if (String(markdown ?? "").trim().length > 200 && isStructureEmpty) {
        return NextResponse.json(
          { error: "Не удалось разобрать структуру протокола" },
          { status: 422 },
        );
      }

      buffer = await generateProtocolDocx(protocol);
    }

    // Браузеры не декодируют percent-encoding в обычном filename — кириллическое
    // имя уходило пользователю как "%D0%9F%D1%80...docx" (см. C5). filename* с
    // percent-encoded UTF-8 — то, что реально читают браузеры; filename= с
    // ASCII-заменой символов вне диапазона — фолбэк для совсем древних клиентов.
    const asciiFilenameFallback = (
      String(filename)
        .replace(/[^\x20-\x7E]/g, "_")
        .trim() || "document.docx"
    ).replace(/"/g, "'");

    return new NextResponse(
      // Buffer, полученный через await (тип Buffer<ArrayBufferLike>), не совпадает
      // по generic-параметру с BodyInit из lib.dom (ждёт Buffer<ArrayBuffer>) —
      // известная нестыковка @types/node/TS 5.7+. Рантайм-поведение не меняется.
      buffer as BodyInit,
      {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${asciiFilenameFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Content-Length": buffer.length.toString(),
        },
      },
    );
  } catch (error) {
    console.error("Error generating docx:", error);
    return NextResponse.json(
      { error: "Failed to generate document" },
      { status: 500 },
    );
  }
}
