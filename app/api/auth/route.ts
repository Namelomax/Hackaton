import {
  createUser,
  getUserByUsername,
  findUserForLogin,
  updateUserPasswordHash,
  getConversations,
} from '@/lib/getPromt';
import { normalizeUsername } from '@/lib/surreal-users';
import { hashPassword, verifyPassword } from '@/lib/auth-password';
import { clearSessionCookieHeader, sessionCookieHeader } from '@/lib/auth-session';

export const runtime = 'nodejs';

function json(body: unknown, status: number, setCookie?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  // Выход: гасим cookie. Тела и пароля тут не требуется.
  if (action === 'logout') {
    return json({ success: true }, 200, clearSessionCookieHeader(req));
  }

  const username = normalizeUsername(String(body?.username ?? ''));
  const password = String(body?.password ?? '');

  if (!username || !password) {
    return json({ success: false, message: 'username and password required' }, 400);
  }

  try {
    if (action === 'register') {
      const existing = await getUserByUsername(username);
      if (existing) {
        return json({ success: false, message: 'User already exists' }, 409);
      }
      const user = await createUser(username, await hashPassword(password));
      const convs = await getConversations(user.id).catch(() => []);
      return json(
        { success: true, user, conversations: convs },
        201,
        sessionCookieHeader(req, user.id),
      );
    }

    if (action === 'login') {
      const found = await findUserForLogin(username);
      // Пароль проверяем в коде, а не в SQL: у scrypt соль индивидуальная.
      const check = found
        ? await verifyPassword(password, found.passwordHash)
        : { ok: false, needsRehash: false };

      if (!found || !check.ok) {
        // Один и тот же ответ на «нет такого пользователя» и «неверный пароль» —
        // иначе форма превращается в проверялку существующих логинов.
        return json({ success: false, message: 'Invalid credentials' }, 401);
      }

      // Пароль верный, но хеш старого формата (несолёный sha256) —
      // пересчитываем прозрачно для пользователя. Пароль менять не нужно.
      if (check.needsRehash) {
        try {
          await updateUserPasswordHash(found.user.id, await hashPassword(password));
          console.log(`[auth] хеш пароля обновлён до scrypt: ${found.user.username}`);
        } catch (e) {
          // Не повод отказывать во входе — попробуем в следующий раз.
          console.warn('[auth] не удалось обновить хеш пароля:', (e as Error)?.message);
        }
      }

      const convs = await getConversations(found.user.id).catch(() => []);
      return json(
        { success: true, user: found.user, conversations: convs },
        200,
        sessionCookieHeader(req, found.user.id),
      );
    }

    return json({ success: false, message: 'Invalid action' }, 400);
  } catch (err: unknown) {
    console.error('Auth error:', err);
    const detail =
      err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
    const payload: Record<string, unknown> = { success: false, message: 'Server error' };
    if (process.env.NODE_ENV === 'development' && detail) {
      payload.detail = detail;
    }
    return json(payload, 500);
  }
}
