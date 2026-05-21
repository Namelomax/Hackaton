import { NextRequest, NextResponse } from 'next/server';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { parseProtocolFromMarkdown } from '@/lib/protocol-from-markdown';

/**
 * Генерирует DOCX из актуального markdown панели (тот же контент, что на сайте).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const markdown = String(body?.markdown ?? '').trim();
    const filename = String(body?.filename ?? 'Протокол.docx').trim() || 'Протокол.docx';

    if (!markdown) {
      return NextResponse.json({ error: 'Missing markdown' }, { status: 400 });
    }

    const protocol = parseProtocolFromMarkdown(markdown);
    if (!protocol) {
      return NextResponse.json(
        { error: 'Could not parse protocol from markdown' },
        { status: 422 },
      );
    }

    const buffer = await generateProtocolDocx(protocol);
    const base64 = buffer.toString('base64');

    return NextResponse.json({
      success: true,
      content: base64,
      filename,
    });
  } catch (error) {
    console.error('[regenerate-protocol-docx]', error);
    return NextResponse.json({ error: 'Failed to generate document' }, { status: 500 });
  }
}
