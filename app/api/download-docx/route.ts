import { type NextRequest, NextResponse } from 'next/server';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { markdownToProtocol } from '@/lib/protocol-markdown-parse';

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
      return NextResponse.json({ error: 'Missing content or filename' }, { status: 400 });
    }

    const buffer = content
      ? Buffer.from(content, 'base64')
      : await generateProtocolDocx(markdownToProtocol(markdown));

    return new NextResponse(
      // Buffer, полученный через await (тип Buffer<ArrayBufferLike>), не совпадает
      // по generic-параметру с BodyInit из lib.dom (ждёт Buffer<ArrayBuffer>) —
      // известная нестыковка @types/node/TS 5.7+. Рантайм-поведение не меняется.
      buffer as BodyInit,
      {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
          'Content-Length': buffer.length.toString(),
        },
      },
    );
  } catch (error) {
    console.error('Error generating docx:', error);
    return NextResponse.json({ error: 'Failed to generate document' }, { status: 500 });
  }
}
