/**
 * Серверные проверки доступа к папке: достать запись и применить правила
 * из lib/access.ts. Отказ — готовый Response, чтобы роуты не дублировали коды.
 */
import { canJoinFolder, canManageFolder, canManageMembers, canSeeFolder, isFolderMember } from '@/lib/access';
import type { Folder, User } from '@/lib/getPromt';
import { getFolder } from '@/lib/getPromt';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Папка, видимая пользователю, или отказ. Невидимую отдаём как 404, а не 403:
 * иначе по ответу можно перебором узнать id чужих личных папок.
 */
export async function visibleFolderOrResponse(user: User, folderId: unknown): Promise<Folder | Response> {
  if (typeof folderId !== 'string' || !folderId.trim()) {
    return json({ success: false, message: 'folderId required' }, 400);
  }
  const folder = await getFolder(folderId);
  if (!folder || !canSeeFolder(user, folder)) {
    return json({ success: false, message: 'Папка не найдена' }, 404);
  }
  return folder;
}

export async function manageableFolderOrResponse(user: User, folderId: unknown): Promise<Folder | Response> {
  const folder = await visibleFolderOrResponse(user, folderId);
  if (folder instanceof Response) return folder;
  if (!canManageFolder(user, folder)) {
    return json({ success: false, message: 'Изменять эту папку может только администратор' }, 403);
  }
  return folder;
}

/**
 * Общая папка для вступления: должна существовать и быть общей. Невидимые
 * личные папки — тоже 404, как и в visibleFolderOrResponse.
 */
export async function sharedFolderOrResponse(folderId: unknown): Promise<Folder | Response> {
  if (typeof folderId !== 'string' || !folderId.trim()) {
    return json({ success: false, message: 'folderId required' }, 400);
  }
  const folder = await getFolder(folderId);
  if (!folder || folder.kind !== 'shared') {
    return json({ success: false, message: 'Папка не найдена' }, 404);
  }
  return folder;
}

/** Папка в виде для клиента: без id владельца и участников, с флагами прав. */
export function folderForClient(user: User, folder: Folder) {
  return {
    id: folder.id,
    name: folder.name,
    kind: folder.kind,
    // Инструкции — только тем, кто в папке работает: в каталоге их не видно.
    instructions: canSeeFolder(user, folder) ? folder.instructions : '',
    canManage: canManageFolder(user, folder),
    canManageMembers: canManageMembers(user, folder),
    isMember: folder.kind === 'shared' ? isFolderMember(user, folder) : true,
    canJoin: canJoinFolder(user, folder),
    memberCount: folder.kind === 'shared' ? folder.memberIds.length : undefined,
    created: folder.created,
    updated: folder.updated,
  };
}
