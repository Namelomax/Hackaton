import { readSurrealConnectionEnv } from '@/lib/surreal-env';

/** Без пароля — для логов и /api/health/db. */
export function surrealConnectionFingerprint(): {
  urlHost: string;
  namespace: string;
  database: string;
  user: string;
} | null {
  const { url, namespace, database, username } = readSurrealConnectionEnv();
  if (!url || !namespace || !database) return null;
  let urlHost = url;
  try {
    urlHost = new URL(url).host;
  } catch {
    /* keep raw */
  }
  return {
    urlHost,
    namespace,
    database,
    user: username ?? '',
  };
}
