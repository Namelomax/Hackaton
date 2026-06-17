import { connectDBForHealth, countUsers } from '@/lib/getPromt';
import { surrealConnectionFingerprint } from '@/lib/surreal-connection-info';

export const dynamic = 'force-dynamic';

/**
 * Диагностика: к какой БД подключено приложение и сколько пользователей в таблице users.
 * С разных машин открывайте один и тот же URL приложения (сервер) и сравнивайте fingerprint + userCount.
 */
export async function GET() {
  const fingerprint = surrealConnectionFingerprint();
  if (!fingerprint) {
    return Response.json(
      { ok: false, error: 'SurrealDB env not configured' },
      { status: 503 },
    );
  }

  try {
    await connectDBForHealth();
    const userCount = await countUsers();
    return Response.json({
      ok: true,
      surreal: fingerprint,
      userCount,
      hint:
        userCount === 0
          ? 'Таблица users пуста в этом namespace/database. Регистрация на другом ПК с другим SURREALDB_URL или другим Docker-томом даст другую базу.'
          : undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, surreal: fingerprint, error: message },
      { status: 500 },
    );
  }
}
