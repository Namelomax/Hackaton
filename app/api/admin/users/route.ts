/**
 * Управление пользователями — только для администратора.
 * Спека: docs/superpowers/specs/2026-10-02-admin-and-folders-design.md
 */
import { adminActionDenial, normalizeRole } from '@/lib/access';
import { requireAdmin } from '@/lib/auth-guard';
import {
  createInvitedUser,
  deleteUserCascade,
  getUserById,
  getUserByUsername,
  listUsersForAdmin,
  resetUserPassword,
  updateUserByAdmin,
} from '@/lib/getPromt';
import { normalizeUsername } from '@/lib/surreal-users';

export const runtime = 'nodejs';

function fail(message: string, status: number): Response {
  return Response.json({ success: false, message }, { status });
}

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  try {
    const users = await listUsersForAdmin();
    return Response.json({ success: true, users });
  } catch (e) {
    console.error('[admin/users] GET', e);
    return fail('Не удалось получить список пользователей', 500);
  }
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  // Только логин: пароль пользователь придумает сам при первом входе
  // (решение заказчика от 02.10.2026 — админ паролями не занимается).
  const body = await req.json().catch(() => ({}));
  const username = normalizeUsername(String(body?.username ?? ''));
  const role = normalizeRole(body?.role);

  if (!username) return fail('Укажите логин', 400);
  if (username.length > 64) return fail('Логин длиннее 64 символов', 400);

  try {
    if (await getUserByUsername(username)) return fail('Такой логин уже есть', 409);
    const user = await createInvitedUser(username, role);
    console.log(`[admin] ${admin.username} пригласил пользователя ${user.username} (${user.role})`);
    return Response.json({ success: true, user }, { status: 201 });
  } catch (e) {
    console.error('[admin/users] POST', e);
    return fail('Не удалось создать пользователя', 500);
  }
}

export async function PATCH(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  if (!userId) return fail('userId required', 400);

  try {
    const target = await getUserById(userId);
    if (!target) return fail('Пользователь не найден', 404);

    const patch: { role?: 'admin' | 'user'; blocked?: boolean } = {};

    if (body.role !== undefined) {
      const role = normalizeRole(body.role);
      if (role !== target.role && role === 'user') {
        const denial = adminActionDenial(admin, target, 'demote');
        if (denial) return fail(denial, 400);
      }
      patch.role = role;
    }

    if (typeof body.blocked === 'boolean') {
      if (body.blocked) {
        const denial = adminActionDenial(admin, target, 'block');
        if (denial) return fail(denial, 400);
      }
      patch.blocked = body.blocked;
    }

    // Сброс пароля: пользователь снова придумает его при входе. Задать пароль
    // за пользователя админ не может — паролей он не знает и не должен.
    if (body.resetPassword === true) {
      const denial = adminActionDenial(admin, target, 'reset');
      if (denial) return fail(denial, 400);
    }

    let updated = await updateUserByAdmin(userId, patch);
    if (body.resetPassword === true) {
      updated = await resetUserPassword(userId);
    }
    const changes = [...Object.keys(patch), ...(body.resetPassword === true ? ['сброс пароля'] : [])];
    console.log(`[admin] ${admin.username} изменил ${target.username}: ${changes.join(', ')}`);
    return Response.json({ success: true, user: updated });
  } catch (e) {
    console.error('[admin/users] PATCH', e);
    return fail('Не удалось изменить пользователя', 500);
  }
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  if (!userId) return fail('userId required', 400);

  try {
    const target = await getUserById(userId);
    if (!target) return fail('Пользователь не найден', 404);
    const denial = adminActionDenial(admin, target, 'delete');
    if (denial) return fail(denial, 400);
    await deleteUserCascade(userId);
    console.log(`[admin] ${admin.username} удалил пользователя ${target.username} со всеми чатами`);
    return Response.json({ success: true });
  } catch (e) {
    console.error('[admin/users] DELETE', e);
    return fail('Не удалось удалить пользователя', 500);
  }
}
