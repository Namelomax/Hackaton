export const runtime = "nodejs";

function ragBase(): string | null {
  const b = process.env.RAG_API_URL?.trim();
  return b ? b.replace(/\/$/, "") : null;
}

export async function GET() {
  const base = ragBase();
  if (!base) {
    return Response.json({ error: "RAG_API_URL is not configured" }, { status: 503 });
  }
  const upstream = await fetch(`${base}/documents`, { method: "GET" });
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
  const upstream = await fetch(`${base}/documents`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
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
