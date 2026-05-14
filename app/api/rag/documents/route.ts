import { resolveRagApiBaseUrl } from "@/lib/rag-api-url";

export const runtime = "nodejs";

function ragBase(): string | null {
  return resolveRagApiBaseUrl();
}

async function fetchRagDocumentsList(base: string, conversationId?: string): Promise<Response> {
  const url = new URL(`${base}/indexed-documents`);
  if (conversationId) url.searchParams.set("conversation_id", conversationId);
  const primary = await fetch(url.toString(), { method: "GET" });
  if (primary.status !== 404) return primary;
  // Fallback to /documents for older images
  const url2 = new URL(`${base}/documents`);
  if (conversationId) url2.searchParams.set("conversation_id", conversationId);
  return fetch(url2.toString(), { method: "GET" });
}

async function fetchRagDocumentsDelete(
  base: string,
  id: string,
  conversationId?: string,
): Promise<Response> {
  const body = JSON.stringify({ id, ...(conversationId ? { conversation_id: conversationId } : {}) });
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

export async function GET(req: Request) {
  const base = ragBase();
  if (!base) {
    return Response.json({ error: "RAG_API_URL is not configured" }, { status: 503 });
  }
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id") ?? undefined;

  let upstream: Response;
  try {
    upstream = await fetchRagDocumentsList(base, conversationId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/rag/documents] GET", msg);
    return Response.json(
      {
        error: "RAG service unreachable",
        ...(process.env.NODE_ENV === "development"
          ? { detail: `${msg}. Локально: запустите rag-api на том же порту.` }
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
  const conversationId =
    typeof body?.conversation_id === "string" ? body.conversation_id : undefined;

  let upstream: Response;
  try {
    upstream = await fetchRagDocumentsDelete(base, id, conversationId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/rag/documents] DELETE", msg);
    return Response.json(
      {
        error: "RAG service unreachable",
        ...(process.env.NODE_ENV === "development" ? { detail: msg } : {}),
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
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "text/plain" },
    });
  }
}
