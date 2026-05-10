export const maxDuration = 300;
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const base = process.env.RAG_API_URL?.replace(/\/$/, '');
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
  const upstream = await fetch(target, {
    method: 'POST',
    body: outgoing,
  });

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
