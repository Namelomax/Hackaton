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
import { anonymizeNewText, AnonymizerUnavailableError } from '@/lib/anonymization';
import {
  saveConversationPreview,
  getConversationPreview,
  getConversationMapping,
} from '@/lib/getPromt';

export const runtime = 'nodejs';
// Полный пайплайн анонимизации (GLiNER + LLM + review + second-pass) на большой
// расшифровке занимает 1–3+ минуты; должен быть больше ANONYMIZER_TIMEOUT_MS.
// 300 — максимум Vercel на текущем плане.
export const maxDuration = 300;

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

  // Собственного таймаута здесь НЕТ. Пробовали ограничивать запрос (110 с) —
  // получили обратный эффект: анонимизатор был жив и заканчивал на второй
  // минуте, а мы обрывали его и писали «анонимизатор недоступен». Когда пора
  // прекращать, решает платформа по maxDuration; клиент при этом не падает —
  // он защищённо разбирает не-JSON ответ.
  //
  // Ограничение можно вернуть точечно через ANONYMIZE_ROUTE_BUDGET_MS (мс),
  // по умолчанию выключено.
  const budgetMs = Number(process.env.ANONYMIZE_ROUTE_BUDGET_MS ?? 0);
  const startedAt = Date.now();
  let timedOut = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const work = anonymizeNewText(fullText, conversationId);
  const raced =
    budgetMs > 0
      ? Promise.race([
          work,
          new Promise<never>((_, reject) => {
            budgetTimer = setTimeout(() => {
              timedOut = true;
              reject(
                new AnonymizerUnavailableError(
                  `анонимизация не завершилась за ${Math.round(budgetMs / 1000)} с`,
                ),
              );
            }, budgetMs);
          }),
        ])
      : work;

  try {
    const result = await raced;
    if (conversationId) {
      try {
        await saveConversationPreview(conversationId, result.anonymizedText);
      } catch (e) {
        console.warn('[anonymize] save preview failed:', (e as Error)?.message);
      }
    }
    return Response.json({
      ok: true,
      anonymizedText: result.anonymizedText,
      summary: result.summary,
      added: result.added,
      mapping: result.mapping,
    });
  } catch (e) {
    if (e instanceof AnonymizerUnavailableError) {
      // Разделяем «сервис не отвечает» и «не успел за бюджет»: во втором случае
      // анонимизатор жив, и говорить пользователю «недоступен» — вводить в
      // заблуждение (он видит в логах, что тот работает).
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.warn(
        `[anonymize] ${timedOut ? 'бюджет исчерпан' : 'сервис недоступен'} за ${elapsed} с: ${e.message}`,
      );
      return Response.json(
        { ok: false, unavailable: true, timeout: timedOut, elapsedSec: elapsed, error: e.message },
        { status: 503 },
      );
    }
    console.error('[anonymize] error:', e);
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'unknown' },
      { status: 500 },
    );
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
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
