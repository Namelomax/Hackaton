import { NextRequest, NextResponse } from 'next/server';

/**
 * API endpoint для скачивания .docx файла протокола
 * Принимает base64-encoded содержимое и возвращает файл для скачивания
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content, filename } = body;

    if (!content || !filename) {
      return NextResponse.json(
        { error: 'Missing content or filename' },
        { status: 400 }
      );
    }

    // Декодируем base64
    const buffer = Buffer.from(content, 'base64');

    // Возвращаем файл для скачивания
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch (error) {
    console.error('Error generating docx:', error);
    return NextResponse.json(
      { error: 'Failed to generate document' },
      { status: 500 }
    );
  }
}
