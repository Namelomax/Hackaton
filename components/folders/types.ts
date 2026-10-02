/** Папка в том виде, в каком её отдаёт /api/folders. */
export type ClientFolder = {
  id: string;
  name: string;
  kind: 'shared' | 'personal';
  instructions: string;
  canManage: boolean;
  /** Админ: добавлять и убирать участников (только общие папки). */
  canManageMembers?: boolean;
  /** Пользователь состоит в общей папке (у личной всегда true). */
  isMember?: boolean;
  /** Можно вступить самому. */
  canJoin?: boolean;
  memberCount?: number;
  created?: string;
  updated?: string;
};

/** Фильтр сайдбара: все чаты, чаты без папки или конкретная папка. */
export type FolderFilter = 'all' | 'none' | string;

/** id папки, в которую попадёт новый чат при текущем фильтре. */
export function folderIdForNewChat(filter: FolderFilter): string | null {
  return filter === 'all' || filter === 'none' ? null : filter;
}

export function conversationMatchesFilter(
  conversation: { folderId?: string | null },
  filter: FolderFilter,
): boolean {
  if (filter === 'all') return true;
  const folderId = conversation.folderId ?? null;
  if (filter === 'none') return !folderId;
  return folderId === filter;
}
