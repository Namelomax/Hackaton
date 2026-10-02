/**
 * Источники папки — документы в RAG-индексе `folder_<id>`.
 * Смотреть может любой, кому видна папка; загружать и удалять — кто ей управляет.
 */
import { folderRagScope } from '@/lib/access';
import { requireUser } from '@/lib/auth-guard';
import { manageableFolderOrResponse, visibleFolderOrResponse } from '@/lib/folder-guard';
import { ragDeleteDocument, ragListDocuments, ragUpload } from '@/lib/rag-proxy';

export const maxDuration = 300;
export const runtime = 'nodejs';

/** 25 МБ — с запасом на расшифровки и регламенты в DOCX/PDF. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export async function GET(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const folder = await visibleFolderOrResponse(user, new URL(req.url).searchParams.get('folderId'));
  if (folder instanceof Response) return folder;
  return ragListDocuments(folderRagScope(folder.id));
}

export async function POST(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const folder = await manageableFolderOrResponse(user, new URL(req.url).searchParams.get('folderId'));
  if (folder instanceof Response) return folder;

  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    return Response.json({ error: 'file field required' }, { status: 400 });
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return Response.json({ error: 'Файл больше 25 МБ' }, { status: 413 });
  }
  return ragUpload(file, folderRagScope(folder.id));
}

export async function DELETE(req: Request) {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });
  const folder = await manageableFolderOrResponse(user, body?.folderId);
  if (folder instanceof Response) return folder;
  return ragDeleteDocument(id, folderRagScope(folder.id));
}
