/**
 * Нормализует ответ db.query() для surrealdb npm ^1.3 (SurrealDB 2.x).
 * Формат может быть [rows] или [{ result: rows, status, time }].
 */
export function surrealQueryRows<T = Record<string, unknown>>(
  response: unknown,
): T[] {
  if (response == null) return [];
  if (!Array.isArray(response)) return [];

  const first = response[0];
  if (Array.isArray(first)) return first as T[];
  if (first && typeof first === 'object' && Array.isArray((first as { result?: unknown }).result)) {
    return (first as { result: T[] }).result;
  }
  return [];
}

export function surrealQueryFirst<T = Record<string, unknown>>(
  response: unknown,
): T | null {
  const rows = surrealQueryRows<T>(response);
  return rows[0] ?? null;
}
