/**
 * Участники общей папки — для администратора: посмотреть, добавить, убрать.
 * Убранный участник не теряет свои чаты: они переезжают в «Без папки».
 */
import { requireAdmin } from '@/lib/auth-guard';
import { folderForClient, sharedFolderOrResponse } from '@/lib/folder-guard';
import { addFolderMember, getUserById, listFolderMembers, removeFolderMember } from '@/lib/getPromt';

export const runtime = 'nodejs';

function fail(message: string, status: number): Response {
  return Response.json({ success: false, message }, { status });
}

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  try {
    const folder = await sharedFolderOrResponse(new URL(req.url).searchParams.get('folderId'));
    if (folder instanceof Response) return folder;
    return Response.json({ success: true, members: await listFolderMembers(folder.id) });
  } catch (e) {
    console.error('[folders/members] GET', e);
    return fail('Не удалось получить участников', 500);
  }
}

async function change(req: Request, action: 'add' | 'remove'): Promise<Response> {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.userId === 'string' ? body.userId : '';
  if (!userId) return fail('userId required', 400);

  try {
    const folder = await sharedFolderOrResponse(body?.folderId);
    if (folder instanceof Response) return folder;
    const target = await getUserById(userId);
    if (!target) return fail('Пользователь не найден', 404);

    const updated =
      action === 'add' ? await addFolderMember(folder.id, target.id) : await removeFolderMember(folder.id, target.id);
    if (!updated) return fail('Папка не найдена', 404);
    console.log(
      `[admin] ${admin.username} ${action === 'add' ? 'добавил' : 'убрал'} ${target.username} ${
        action === 'add' ? 'в' : 'из'
      } папк${action === 'add' ? 'у' : 'и'} «${folder.name}»`,
    );
    return Response.json({
      success: true,
      folder: folderForClient(admin, updated),
      members: await listFolderMembers(folder.id),
    });
  } catch (e) {
    console.error(`[folders/members] ${action}`, e);
    return fail('Не удалось изменить участников', 500);
  }
}

export function POST(req: Request) {
  return change(req, 'add');
}

export function DELETE(req: Request) {
  return change(req, 'remove');
}
