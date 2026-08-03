/**
 * POST /api/anonymize — анонимизирует документ/текст и сохраняет канонический
 * mapping диалога. Используется для PREVIEW перед отправкой в облако.
 *
 * Body: { conversationId?: string, text?: string, files?: Attachment[] }
 *
 * Ответ: { ok, anonymizedText, summary, added, mapping }
 *   503 + { unavailable: true } — анонимизатор недоступен (UI делает fallback).
 *
 * GET /api/anonymize?conversationId=... — вернуть сохранённые mapping и
 * анонимизированный preview-текст (для восстановления при перезагрузке).
 */
import { extractAttachmentText } from '@/lib/attachment-extract';
import {
  AnonymizerUnavailableError,
  completeAnonymizeJob,
  startAnonymizeJob,
} from '@/lib/anonymization';
import {
  saveConversationPreview,
  getConversationPreview,
  getConversationMapping,
} from '@/lib/getPromt';

export const runtime = 'nodejs';
// Ни один запрос сюда больше не длится дольше нескольких секунд: POST ставит
// задачу на анонимизаторе и сразу отдаёт jobId, GET?jobId=... делает ОДИН
// опрос статуса. Сама анонимизация идёт на сервере анонимизатора и живёт
// независимо от того, сколько раз браузер успел спросить.
//
// Раньше здесь стоял maxDuration = 300 и весь пайплайн ждался внутри одной
// инвокации — из-за этого потолок платформы был потолком анонимизации. Теперь
// он не ограничивает НИЧЕГО: задача может считаться пять минут или пятнадцать,
// браузер просто продолжает опрашивать.
export const maxDuration = 60;

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

  // Никаких таймаутов и бюджетов здесь больше нет: этот запрос только СТАВИТ
  // задачу и возвращается. Ждать нечего, обрывать нечего.
  try {
    const started = await startAnonymizeJob(fullText, conversationId);

    if (started.kind === 'job') {
      return Response.json({ ok: true, jobId: started.jobId, done: false }, { status: 202 });
    }

    // Работы не было (пустой текст) либо анонимизатор без job-API отработал
    // синхронно — отдаём готовый результат тем же форматом, что и GET.
    await savePreview(conversationId, started.result.anonymizedText);
    return Response.json({ ok: true, done: true, ...payloadOf(started.result) });
  } catch (e) {
    return errorResponse(e);
  }
}

function payloadOf(result: {
  anonymizedText: string;
  summary: Record<string, number>;
  added: number;
  mapping: Record<string, string>;
}) {
  return {
    anonymizedText: result.anonymizedText,
    summary: result.summary,
    added: result.added,
    mapping: result.mapping,
  };
}

async function savePreview(conversationId: string | null, text: string): Promise<void> {
  if (!conversationId) return;
  try {
    await saveConversationPreview(conversationId, text);
  } catch (e) {
    console.warn('[anonymize] save preview failed:', (e as Error)?.message);
  }
}

function errorResponse(e: unknown): Response {
  if (e instanceof AnonymizerUnavailableError) {
    console.warn(`[anonymize] сервис недоступен: ${e.message}`);
    return Response.json(
      { ok: false, unavailable: true, timeout: false, error: e.message },
      { status: 503 },
    );
  }
  console.error('[anonymize] error:', e);
  return Response.json(
    { ok: false, error: e instanceof Error ? e.message : 'unknown' },
    { status: 500 },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');

  // Опрос фоновой задачи. Один короткий запрос: спросили статус — ответили.
  // Пока не готово, отдаём 200 {done:false}, а не 202/204: браузер отличает
  // «ещё считается» по полю, и промежуточный статус не путается с ошибкой.
  const jobId = url.searchParams.get('jobId');
  if (jobId) {
    try {
      const state = await completeAnonymizeJob(jobId, conversationId);
      if (!state.done) return Response.json({ ok: true, done: false });
      await savePreview(conversationId, state.result.anonymizedText);
      return Response.json({ ok: true, done: true, ...payloadOf(state.result) });
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (!conversationId) {
    return Response.json({ ok: false, error: 'conversationId required' }, { status: 400 });
  }
  try {
    const [stored, previewText] = await Promise.all([
      getConversationMapping(conversationId),
      getConversationPreview(conversationId),
    ]);
    return Response.json({
      ok: true,
      mapping: stored.mapping ?? {},
      anonymizedText: previewText ?? '',
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  }
}
