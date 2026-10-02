/**
 * Проектные папки: общие (ведёт администратор) и личные (видит только владелец).
 * Спека: docs/superpowers/specs/2026-10-02-admin-and-folders-design.md
 */
import {
  canCreateFolder,
  isFolderMember,
  normalizeFolderInstructions,
  normalizeFolderName,
  type FolderKind,
} from '@/lib/access';
import { requireUser } from '@/lib/auth-guard';
import { folderForClient, manageableFolderOrResponse } from '@/lib/folder-guard';
import { createFolder, deleteFolder, listFoldersForUser, updateFolder } from '@/lib/getPromt';

export const runtime = 'nodejs';

function fail(message: string, status: number): Response {
  return Response.json({ success: false, message }, { status });
}

/**
 * GET              — папки для сайдбара: личные + общие, где пользователь участник.
 * GET ?scope=catalog — каталог всех общих папок: вступить/выйти, админу — управлять.
 *
 * Админ в сайдбаре тоже видит только свои общие папки: проектов может быть
 * много, а управлять остальными он может из каталога.
 */
export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const catalog = new URL(req.url).searchParams.get('scope') === 'catalog';
  try {
    const all = await listFoldersForUser(user.id);
    const folders = catalog
      ? all.filter((f) => f.kind === 'shared')
      : all.filter((f) => f.kind === 'personal' || isFolderMember(user, f));
    return Response.json({ success: true, folders: folders.map((f) => folderForClient(user, f)) });
  } catch (e) {
    console.error('[folders] GET', e);
    return fail('Не удалось получить папки', 500);
  }
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => ({}));
  const kind: FolderKind = body?.kind === 'shared' ? 'shared' : 'personal';
  const name = normalizeFolderName(body?.name);
  if (!name) return fail('Укажите название папки', 400);
  if (!canCreateFolder(user, kind)) return fail('Общие папки создаёт администратор', 403);

  try {
    // Создавший общую папку админ сразу в ней — иначе она не появится у него в сайдбаре.
    const folder = await createFolder({
      name,
      kind,
      ownerId: kind === 'personal' ? user.id : null,
      memberIds: kind === 'shared' ? [user.id] : [],
      // Инструкции необязательны — пустая строка допустима.
      instructions: normalizeFolderInstructions(body?.instructions),
    });
    return Response.json({ success: true, folder: folderForClient(user, folder) }, { status: 201 });
  } catch (e) {
    console.error('[folders] POST', e);
    return fail('Не удалось создать папку', 500);
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => ({}));
  try {
    const folder = await manageableFolderOrResponse(user, body?.folderId);
    if (folder instanceof Response) return folder;

    const patch: { name?: string; instructions?: string } = {};
    if (body.name !== undefined) {
      const name = normalizeFolderName(body.name);
      if (!name) return fail('Название папки не может быть пустым', 400);
      patch.name = name;
    }
    if (body.instructions !== undefined) {
      patch.instructions = normalizeFolderInstructions(body.instructions);
    }
    const updated = await updateFolder(folder.id, patch);
    if (!updated) return fail('Папка не найдена', 404);
    return Response.json({ success: true, folder: folderForClient(user, updated) });
  } catch (e) {
    console.error('[folders] PATCH', e);
    return fail('Не удалось изменить папку', 500);
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const body = await req.json().catch(() => ({}));
  try {
    const folder = await manageableFolderOrResponse(user, body?.folderId);
    if (folder instanceof Response) return folder;
    await deleteFolder(folder.id);
    return Response.json({ success: true });
  } catch (e) {
    console.error('[folders] DELETE', e);
    return fail('Не удалось удалить папку', 500);
  }
}
