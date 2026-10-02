/**
 * Прокси к rag-api: загрузка, список и удаление документов индекса.
 *
 * Индекс выбирается строкой `scope`, которую RAG-сервис называет
 * `conversation_id` (это просто имя каталога). Для диалога это id диалога,
 * для папки — `folder_<id>` (lib/access.ts → folderRagScope).
 *
 * Доступ здесь НЕ проверяется — это делают роуты до вызова.
 */
import { resolveRagApiBaseUrl } from '@/lib/rag-api-url';

function notConfigured(): Response {
  return Response.json({ error: 'RAG_API_URL is not configured' }, { status: 503 });
}

function unreachable(where: string, e: unknown, hint: string): Response {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[rag-proxy] ${where}`, msg);
  return Response.json(
    {
      error: 'RAG service unreachable',
      ...(process.env.NODE_ENV === 'development' ? { detail: `${msg}. ${hint}` } : {}),
    },
    { status: 502 },
  );
}

/** Ответ RAG как есть: JSON — JSON, иначе текст с исходным типом. */
async function passThrough(upstream: Response): Promise<Response> {
  const text = await upstream.text();
  try {
    return Response.json(JSON.parse(text), { status: upstream.status });
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' },
    });
  }
}

export async function ragUpload(file: Blob, scope: string | null): Promise<Response> {
  const base = resolveRagApiBaseUrl();
  if (!base) return notConfigured();

  const outgoing = new FormData();
  outgoing.append('file', file);
  const targetUrl = new URL(`${base}/upload`);
  targetUrl.searchParams.set('wait', 'true');
  if (scope) targetUrl.searchParams.set('conversation_id', scope);

  try {
    return await passThrough(await fetch(targetUrl.toString(), { method: 'POST', body: outgoing }));
  } catch (e) {
    return unreachable('upload', e, 'Локально: запустите rag-api и проверьте порт (часто 8000).');
  }
}

export async function ragListDocuments(scope: string | null): Promise<Response> {
  const base = resolveRagApiBaseUrl();
  if (!base) return notConfigured();

  const urlFor = (path: string) => {
    const url = new URL(`${base}${path}`);
    if (scope) url.searchParams.set('conversation_id', scope);
    return url.toString();
  };
  try {
    const primary = await fetch(urlFor('/indexed-documents'), { method: 'GET' });
    // Старые образы rag-api знают только /documents.
    const upstream = primary.status !== 404 ? primary : await fetch(urlFor('/documents'), { method: 'GET' });
    return await passThrough(upstream);
  } catch (e) {
    return unreachable('list', e, 'Локально: запустите rag-api на том же порту.');
  }
}

export async function ragDeleteDocument(id: string, scope: string | null): Promise<Response> {
  const base = resolveRagApiBaseUrl();
  if (!base) return notConfigured();

  const init = {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...(scope ? { conversation_id: scope } : {}) }),
  };
  try {
    const primary = await fetch(`${base}/indexed-documents`, init);
    const upstream = primary.status !== 404 ? primary : await fetch(`${base}/documents`, init);
    return await passThrough(upstream);
  } catch (e) {
    return unreachable('delete', e, '');
  }
}
