import {
  createUser,
  getUserByUsername,
  findUserForLogin,
  updateUserPasswordHash,
  getConversations,
  touchUserLastLogin,
  updateUserByAdmin,
  claimInvitedUser,
  type User,
} from '@/lib/getPromt';
import { normalizeUsername } from '@/lib/surreal-users';
import { hashPassword, verifyPassword } from '@/lib/auth-password';
import { clearSessionCookieHeader, sessionCookieHeader } from '@/lib/auth-session';
import { authenticateRequest, requireUser } from '@/lib/auth-guard';
import { isEnvAdmin, passwordProblem } from '@/lib/access';

export const runtime = 'nodejs';

function json(body: unknown, status: number, setCookie?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(JSON.stringify(body), { status, headers });
}

/** Что о пользователе знает клиент. Хеш пароля и прочее сюда не попадают. */
function publicUser(user: User) {
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * Текущий пользователь по сессии. Клиент спрашивает при загрузке: роль могла
 * смениться, а учётку — заблокировать или удалить, пока вкладка была закрыта.
 */
export async function GET(req: Request) {
  try {
    const auth = await authenticateRequest(req);
    if (auth.status === 'anonymous') {
      return json({ success: false, unauthorized: true }, 401, clearSessionCookieHeader(req));
    }
    if (auth.status === 'blocked') {
      return json(
        { success: false, unauthorized: true, blocked: true, message: 'Доступ заблокирован администратором' },
        403,
        clearSessionCookieHeader(req),
      );
    }
    return json({ success: true, user: publicUser(auth.user) }, 200);
  } catch (err) {
    console.error('Auth GET error:', err);
    return json({ success: false, message: 'Проверка доступа временно недоступна' }, 503);
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  // Выход: гасим cookie. Тела и пароля тут не требуется.
  if (action === 'logout') {
    return json({ success: true }, 200, clearSessionCookieHeader(req));
  }

  if (action === 'change-password') {
    return changePassword(req, body);
  }

  if (action === 'set-initial-password') {
    return setInitialPassword(req, body);
  }

  const username = normalizeUsername(String(body?.username ?? ''));
  const password = String(body?.password ?? '');

  // Пароль при входе может быть пустым: так приглашённый пользователь узнаёт,
  // что ему нужно придумать пароль. Для учёток с паролем пустой даст отказ.
  if (!username || (!password && action !== 'login')) {
    return json({ success: false, message: 'username and password required' }, 400);
  }

  try {
    if (action === 'register') {
      // Учётки выдаёт администратор (/admin). Сам зарегистрироваться может
      // только логин из ADMIN_USERNAMES — иначе первого админа не создать.
      if (!isEnvAdmin(username)) {
        return json(
          { success: false, message: 'Учётные записи выдаёт администратор. Обратитесь к нему за доступом.' },
          403,
        );
      }
      const existing = await getUserByUsername(username);
      if (existing) {
        return json({ success: false, message: 'User already exists' }, 409);
      }
      const weak = passwordProblem(password);
      if (weak) return json({ success: false, message: weak }, 400);
      const user = await createUser(username, await hashPassword(password), 'admin');
      return json(
        { success: true, user: publicUser(user), conversations: [] },
        201,
        sessionCookieHeader(req, user.id),
      );
    }

    if (action === 'login') {
      const found = await findUserForLogin(username);

      // Логин из ADMIN_USERNAMES, которого ещё нет в базе, — первый вход
      // администратора. Ведём его тем же путём, что и приглашённых: «введите
      // логин → придумайте пароль». Раньше для этого была отдельная ссылка
      // «Первый вход администратора», и обычный вход отвечал «неверный логин».
      if (!found && isEnvAdmin(username)) {
        return json(
          { success: false, needsPassword: true, username, message: 'Придумайте пароль' },
          409,
        );
      }

      // Приглашённый пользователь: пароля ещё нет, его надо придумать.
      // Пароль из формы не проверяем — сверять не с чем.
      if (found && found.user.state !== 'active') {
        if (found.user.blocked) {
          return json(
            { success: false, blocked: true, message: 'Доступ заблокирован администратором' },
            403,
          );
        }
        if (found.user.state === 'expired') {
          return json(
            {
              success: false,
              inviteExpired: true,
              message: 'Приглашение истекло. Попросите администратора сбросить пароль.',
            },
            403,
          );
        }
        return json(
          { success: false, needsPassword: true, username: found.user.username, message: 'Придумайте пароль' },
          409,
        );
      }

      // Пароль проверяем в коде, а не в SQL: у scrypt соль индивидуальная.
      const check = found
        ? await verifyPassword(password, found.passwordHash)
        : { ok: false, needsRehash: false };

      if (!found || !check.ok) {
        // Один и тот же ответ на «нет такого пользователя» и «неверный пароль» —
        // иначе форма превращается в проверялку существующих логинов.
        return json({ success: false, message: 'Invalid credentials' }, 401);
      }

      // О блокировке говорим только после верного пароля: так ответ не
      // раскрывает, какие логины существуют.
      if (found.user.blocked) {
        return json(
          { success: false, blocked: true, message: 'Доступ заблокирован администратором' },
          403,
        );
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

      await touchUserLastLogin(found.user.id);
      const convs = await getConversations(found.user.id).catch(() => []);
      return json(
        { success: true, user: publicUser(found.user), conversations: convs },
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

/**
 * Первый вход приглашённого пользователя: он сам придумывает пароль и сразу
 * входит. Админ пароли не задаёт и не знает.
 */
async function setInitialPassword(req: Request, body: Record<string, unknown>): Promise<Response> {
  const username = normalizeUsername(String(body?.username ?? ''));
  const newPassword = String(body?.newPassword ?? '');
  if (!username) return json({ success: false, message: 'username required' }, 400);
  const weak = passwordProblem(newPassword);
  if (weak) return json({ success: false, message: weak }, 400);

  try {
    const found = await findUserForLogin(username);

    // Первый вход администратора из ADMIN_USERNAMES: учётки ещё нет —
    // создаём её с придуманным паролем и сразу пускаем.
    if (!found && isEnvAdmin(username)) {
      const user = await createUser(username, await hashPassword(newPassword), 'admin');
      console.log(`[auth] создан администратор ${user.username} (ADMIN_USERNAMES)`);
      await touchUserLastLogin(user.id);
      return json(
        { success: true, user: publicUser(user), conversations: [] },
        201,
        sessionCookieHeader(req, user.id),
      );
    }

    // Нет учётки или пароль уже задан — один ответ: не подсказываем, какие
    // логины существуют и в каком они состоянии.
    if (!found || found.user.state === 'active') {
      return json({ success: false, message: 'Пароль для этой учётной записи уже задан — войдите с ним' }, 409);
    }
    if (found.user.blocked) {
      return json({ success: false, blocked: true, message: 'Доступ заблокирован администратором' }, 403);
    }
    if (found.user.state === 'expired') {
      return json(
        { success: false, inviteExpired: true, message: 'Приглашение истекло. Попросите администратора сбросить пароль.' },
        403,
      );
    }
    const claimed = await claimInvitedUser(found.user.id, await hashPassword(newPassword));
    if (!claimed) {
      // Кто-то успел раньше (две вкладки или чужой человек). Пусть разбирается админ.
      return json({ success: false, message: 'Пароль для этой учётной записи уже задан — войдите с ним' }, 409);
    }
    console.log(`[auth] ${found.user.username} задал пароль при первом входе`);
    await touchUserLastLogin(found.user.id);
    const convs = await getConversations(found.user.id).catch(() => []);
    return json(
      { success: true, user: publicUser({ ...found.user, state: 'active' }), conversations: convs },
      200,
      sessionCookieHeader(req, found.user.id),
    );
  } catch (err) {
    console.error('Set initial password error:', err);
    return json({ success: false, message: 'Server error' }, 500);
  }
}

/** Смена своего пароля. */
async function changePassword(req: Request, body: Record<string, unknown>): Promise<Response> {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const currentPassword = String(body?.currentPassword ?? '');
  const newPassword = String(body?.newPassword ?? '');
  const weak = passwordProblem(newPassword);
  if (weak) return json({ success: false, message: weak }, 400);

  try {
    const found = await findUserForLogin(user.username);
    const check = found ? await verifyPassword(currentPassword, found.passwordHash) : { ok: false };
    if (!found || !check.ok) {
      return json({ success: false, message: 'Текущий пароль неверен' }, 400);
    }
    // updateUserPasswordHash глотает ошибки (там это миграция «при случае»);
    // здесь пользователь должен узнать, что пароль НЕ сменился.
    await updateUserByAdmin(user.id, { passwordHash: await hashPassword(newPassword) });
    return json({ success: true }, 200);
  } catch (err) {
    console.error('Change password error:', err);
    return json({ success: false, message: 'Server error' }, 500);
  }
}
