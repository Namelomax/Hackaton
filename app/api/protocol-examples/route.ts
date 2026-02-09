import { NextRequest, NextResponse } from 'next/server';
import { saveProtocolExample } from '@/lib/getPromt';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const content = String(body?.content ?? '').trim();

    if (!content || content.length < 50) {
      return NextResponse.json({ error: 'Content is too short' }, { status: 400 });
    }

    const saved = await saveProtocolExample(content);
    return NextResponse.json({ success: true, example: saved }, { status: 200 });
  } catch (error) {
    console.error('Failed to save protocol example:', error);
    return NextResponse.json({ error: 'Failed to save example' }, { status: 500 });
  }
}
