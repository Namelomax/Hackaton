/**
 * Базовый URL rag-api для серверных `fetch` из Next.js.
 *
 * При локальном `next dev` в `.env` часто остаётся `http://rag-api:8000` из шаблона Docker —
 * на хосте имя не резолвится. Только в режиме разработки (`NODE_ENV === 'development'`)
 * hostname `rag-api` заменяется на `127.0.0.1` с тем же портом.
 *
 * В production (`next start`, сборка на сервере) строка из `RAG_API_URL` не изменяется.
 */
export function resolveRagApiBaseUrl(): string | null {
  const raw = process.env.RAG_API_URL?.trim();
  if (!raw) return null;

  const noTrailing = raw.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "development") {
    return noTrailing;
  }

  try {
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `http://${raw}`;
    const u = new URL(normalized);
    if (u.hostname.toLowerCase() === "rag-api") {
      u.hostname = "127.0.0.1";
      return u.toString().replace(/\/$/, "");
    }
    return noTrailing;
  } catch {
    return noTrailing;
  }
}
