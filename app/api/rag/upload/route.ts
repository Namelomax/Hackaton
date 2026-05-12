import { resolveRagApiBaseUrl } from '@/lib/rag-api-url';

export const maxDuration = 300;
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const base = resolveRagApiBaseUrl();
  if (!base) {
    return Response.json({ error: 'RAG_API_URL is not configured' }, { status: 503 });
  }

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return Response.json({ error: 'file field required' }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.append('file', file);

  const target = `${base}/upload?wait=true`;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      body: outgoing,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[api/rag/upload]', msg);
    return Response.json(
      {
        error: 'RAG service unreachable',
        ...(process.env.NODE_ENV === 'development'
          ? { detail: `${msg}. Локально: запустите rag-api и проверьте порт (часто 8000).` }
          : {}),
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  try {
    const json = JSON.parse(text);
    return Response.json(json, { status: upstream.status });
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' },
    });
  }
}
