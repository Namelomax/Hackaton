/**
 * HTTP-клиент к rag-api (индексация /query). Используется из route и из инструмента RAG.
 */
export async function fetchRagSnippet(question: string, mode: string): Promise<string> {
  const base = process.env.RAG_API_URL?.trim();
  if (!base || !question.trim()) return '';

  const normalizedMode = ['hybrid', 'local', 'global'].includes(mode) ? mode : 'hybrid';

  try {
    const url = `${base.replace(/\/$/, '')}/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: question.slice(0, 8000),
        mode: normalizedMode,
      }),
    });
    if (!res.ok) return '';
    const data = (await res.json().catch(() => null)) as { answer?: string } | null;
    const answer = typeof data?.answer === 'string' ? data.answer : '';
    return answer.trim().slice(0, 12000);
  } catch {
    return '';
  }
}
