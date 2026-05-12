/**
 * Поддержка двух соглашений имён (Docker/README vs локальный .env):
 * - SURREALDB_* (основной)
 * - SURREAL_* / SURREAL_PASS (часто в облачных шаблонах)
 */
export function readSurrealConnectionEnv(): {
  url?: string;
  namespace?: string;
  database?: string;
  username?: string;
  password?: string;
} {
  const url =
    process.env.SURREALDB_URL?.trim() || process.env.SURREAL_URL?.trim();
  const namespace =
    process.env.SURREALDB_NAMESPACE?.trim() ||
    process.env.SURREAL_NAMESPACE?.trim();
  const database =
    process.env.SURREALDB_DATABASE?.trim() ||
    process.env.SURREAL_DATABASE?.trim();
  const username =
    process.env.SURREALDB_USER?.trim() || process.env.SURREAL_USER?.trim();
  const password =
    process.env.SURREALDB_PASSWORD?.trim() ||
    process.env.SURREAL_PASSWORD?.trim() ||
    process.env.SURREAL_PASS?.trim();
  return { url, namespace, database, username, password };
}

export function surrealEnvMissingMessage(): string {
  return (
    'Missing SurrealDB env: use SURREALDB_URL, SURREALDB_NAMESPACE, SURREALDB_DATABASE, SURREALDB_USER, SURREALDB_PASSWORD ' +
    'or aliases SURREAL_URL, SURREAL_NAMESPACE, SURREAL_DATABASE, SURREAL_USER, SURREAL_PASS'
  );
}
