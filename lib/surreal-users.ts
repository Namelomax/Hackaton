/** Нормализация логина: trim + единый регистр для поиска и уникальности. */
export function normalizeUsername(username: string): string {
  return String(username ?? '').trim();
}

export function usernameLookupKey(username: string): string {
  return normalizeUsername(username).toLowerCase();
}
