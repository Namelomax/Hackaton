export const runtime = "nodejs";

function ragBase(): string | null {
  const b = process.env.RAG_API_URL?.trim();
  return b ? b.replace(/\/$/, "") : null;
}

/** Список/удаление: сначала новый путь (меньше конфликтов с прокси), затем /documents. */
async function fetchRagDocumentsList(base: string): Promise<Response> {
  const primary = await fetch(`${base}/indexed-documents`, { method: "GET" });
  if (primary.status !== 404) return primary;
  return fetch(`${base}/documents`, { method: "GET" });
}

async function fetchRagDocumentsDelete(base: string, id: string): Promise<Response> {
  const body = JSON.stringify({ id });
  const primary = await fetch(`${base}/indexed-documents`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (primary.status !== 404) return primary;
  return fetch(`${base}/documents`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

export async function GET() {
  const base = ragBase();
  if (!base) {
    return Response.json({ error: "RAG_API_URL is not configured" }, { status: 503 });
  }
  const upstream = await fetchRagDocumentsList(base);
  const text = await upstream.text();
  try {
    const json = JSON.parse(text);
    return Response.json(json, { status: upstream.status });
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/plain" },
    });
  }
}

export async function DELETE(req: Request) {
  const base = ragBase();
  if (!base) {
    return Response.json({ error: "RAG_API_URL is not configured" }, { status: 503 });
  }
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }
  const upstream = await fetchRagDocumentsDelete(base, id);
  const text = await upstream.text();
  try {
    const json = JSON.parse(text);
    return Response.json(json, { status: upstream.status });
  } catch {
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/plain" },
    });
  }
}
