/**
 * POST /api/anonymize — анонимизирует документ/текст и сохраняет канонический
 * mapping диалога. Используется для PREVIEW перед отправкой в облако.
 *
 * Body: { conversationId?: string, text?: string, files?: Attachment[] }
 *   Attachment: { url|data, mediaType|mimeType, name|filename, content? }
 *
 * Ответ: { ok, anonymizedText, summary, added }
 *   503 + { unavailable: true } — анонимизатор недоступен (UI делает fallback).
 */
import { extractAttachmentText } from '@/lib/attachment-extract';
import { anonymizeNewText, AnonymizerUnavailableError } from '@/lib/anonymization';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const conversationId: string | null =
    typeof body.conversationId === 'string' ? body.conversationId : null;
  const files: any[] = Array.isArray(body.files) ? body.files : [];

  const parts: string[] = [];
  if (typeof body.text === 'string' && body.text.trim()) parts.push(body.text.trim());

  for (const f of files) {
    try {
      const extracted = await extractAttachmentText(f);
      const name = f?.name || f?.filename || 'документ';
      if (extracted && extracted.trim()) {
        parts.push(`Документ "${name}":\n${extracted.trim()}`);
      }
    } catch (e) {
      console.error('[anonymize] extract failed:', (e as Error)?.message);
    }
  }

  const fullText = parts.join('\n\n').trim();
  if (!fullText) {
    return Response.json({ ok: false, error: 'нет текста для анонимизации' }, { status: 400 });
  }

  try {
    const result = await anonymizeNewText(fullText, conversationId);
    return Response.json({
      ok: true,
      anonymizedText: result.anonymizedText,
      summary: result.summary,
      added: result.added,
    });
  } catch (e) {
    if (e instanceof AnonymizerUnavailableError) {
      return Response.json(
        { ok: false, unavailable: true, error: e.message },
        { status: 503 },
      );
    }
    console.error('[anonymize] error:', e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
