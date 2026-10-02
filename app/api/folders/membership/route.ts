/**
 * Своё участие в общей папке: вступить или выйти.
 * Вступить может любой активный пользователь — так решил заказчик (02.10.2026):
 * люди сами добавляются в нужные проекты.
 */
import { requireUser } from '@/lib/auth-guard';
import { folderForClient, sharedFolderOrResponse } from '@/lib/folder-guard';
import { addFolderMember, removeFolderMember } from '@/lib/getPromt';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'join' && action !== 'leave') {
    return Response.json({ success: false, message: 'action: join | leave' }, { status: 400 });
  }

  try {
    const folder = await sharedFolderOrResponse(body?.folderId);
    if (folder instanceof Response) return folder;
    const updated =
      action === 'join' ? await addFolderMember(folder.id, user.id) : await removeFolderMember(folder.id, user.id);
    if (!updated) return Response.json({ success: false, message: 'Папка не найдена' }, { status: 404 });
    return Response.json({ success: true, folder: folderForClient(user, updated) });
  } catch (e) {
    console.error('[folders/membership]', e);
    return Response.json({ success: false, message: 'Не удалось изменить участие' }, { status: 500 });
  }
}
