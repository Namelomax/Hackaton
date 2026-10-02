'use client';

import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderInput,
  FolderLock,
  Inbox,
  Layers,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type ClientFolder, conversationMatchesFilter, type FolderFilter } from '@/components/folders/types';
import { formatChatListDate, getChatSidebarLabel } from '@/lib/chat-display';

type Conversation = {
  id: string;
  title?: string | null;
  created?: string | null;
  messages?: any[];
  folderId?: string | null;
  [key: string]: any;
};

type SidebarProps = {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (conversation: Conversation) => void;
  onNewLocal: () => void;
  onRename: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Папки: без них (гость) блок папок не показывается. */
  folders?: ClientFolder[];
  folderFilter?: FolderFilter;
  onFolderFilterChange?: (filter: FolderFilter) => void;
  onCreateFolder?: (kind: 'shared' | 'personal') => void;
  onOpenFolder?: (folder: ClientFolder) => void;
  onMoveConversation?: (conversation: Conversation, folderId: string | null) => void;
  /** Каталог общих папок: вступить/выйти, админу — создать и настроить. */
  onOpenCatalog?: () => void;
};

type FolderRowProps = {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onSettings?: () => void;
  settingsLabel?: string;
};

const FolderRow = ({ icon, label, count, active, onClick, onSettings, settingsLabel }: FolderRowProps) => (
  <li
    className={`group flex items-center gap-1 rounded hover:bg-muted/30 ${
      active ? 'bg-muted/50 font-medium' : ''
    }`}
  >
    <button
      type="button"
      className="flex flex-1 min-w-0 items-center gap-1.5 px-2 py-1 text-left"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="text-[10px] opacity-50">{count || ''}</span>
    </button>
    {onSettings && (
      <button
        type="button"
        className="shrink-0 mr-1 p-0.5 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-muted"
        onClick={onSettings}
        aria-label={settingsLabel}
        title={settingsLabel}
      >
        <Settings2 className="w-3 h-3" />
      </button>
    )}
  </li>
);

const SectionLabel = ({
  children,
  onAdd,
  addLabel,
}: {
  children: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
}) => (
  <div className="flex items-center justify-between px-2 pt-2 pb-0.5">
    <span className="text-[10px] uppercase tracking-wide opacity-60">{children}</span>
    {onAdd && (
      <button
        type="button"
        onClick={onAdd}
        className="p-0.5 rounded hover:bg-muted"
        aria-label={addLabel}
        title={addLabel}
      >
        <Plus className="w-3 h-3" />
      </button>
    )}
  </div>
);

export const Sidebar = ({
  conversations,
  activeId,
  onSelect,
  onNewLocal,
  onRename,
  onDelete,
  collapsed,
  onToggleCollapsed,
  folders,
  folderFilter = 'all',
  onFolderFilterChange,
  onCreateFolder,
  onOpenFolder,
  onMoveConversation,
  onOpenCatalog,
}: SidebarProps) => {
  const showFolders = Array.isArray(folders) && Boolean(onFolderFilterChange);
  const shared = useMemo(() => (folders ?? []).filter((f) => f.kind === 'shared'), [folders]);
  const personal = useMemo(() => (folders ?? []).filter((f) => f.kind === 'personal'), [folders]);

  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    let none = 0;
    for (const c of conversations) {
      if (c.folderId) byFolder.set(c.folderId, (byFolder.get(c.folderId) ?? 0) + 1);
      else none++;
    }
    return { byFolder, none };
  }, [conversations]);

  const visibleConversations = useMemo(
    () => (showFolders ? conversations.filter((c) => conversationMatchesFilter(c, folderFilter)) : conversations),
    [conversations, folderFilter, showFolders],
  );

  const activeFolder = (folders ?? []).find((f) => f.id === folderFilter);
  const listTitle = !showFolders || folderFilter === 'all'
    ? 'Ваши чаты'
    : folderFilter === 'none'
      ? 'Без папки'
      : (activeFolder?.name ?? 'Папка');

  return (
    <div
      className={
        `border-r flex flex-col shrink-0 bg-muted/10 overflow-hidden ` +
        `transition-[width] duration-200 ease-in-out ` +
        (collapsed ? 'w-10' : 'w-60')
      }
    >
      <div className="relative p-2 flex items-center justify-between border-b">
        <div
          className={
            `flex items-center justify-between w-full gap-2 transition-all duration-200 ` +
            (collapsed ? 'opacity-0 -translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0')
          }
        >
          <span className="text-xs font-medium truncate" title={listTitle}>
            {listTitle}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onNewLocal}
              className="text-xs px-2 py-1 border rounded"
              type="button"
              title={activeFolder ? `Новый чат в папке «${activeFolder.name}»` : 'Новый чат'}
            >
              Новый
            </button>
            <button
              onClick={onToggleCollapsed}
              className="p-1 border rounded"
              aria-label="Скрыть чаты"
              title="Скрыть чаты"
              type="button"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div
          className={
            `absolute left-0 right-0 p-2 flex items-center justify-center transition-all duration-200 ` +
            (collapsed ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2 pointer-events-none')
          }
        >
          <button
            onClick={onToggleCollapsed}
            className="p-1 border rounded"
            aria-label="Показать чаты"
            title="Показать чаты"
            type="button"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showFolders && (
        <div
          className={
            `border-b max-h-[45%] overflow-auto pb-1 transition-all duration-200 ` +
            (collapsed ? 'opacity-0 -translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0')
          }
        >
          <ul className="text-sm px-1 pt-1">
            <FolderRow
              icon={<Layers className="w-3.5 h-3.5" />}
              label="Все чаты"
              count={conversations.length}
              active={folderFilter === 'all'}
              onClick={() => onFolderFilterChange?.('all')}
            />
            {/* Пока ни один чат не лежит в папке, «Без папки» = «Все чаты» — не дублируем. */}
            {(counts.none < conversations.length || folderFilter === 'none') && (
              <FolderRow
                icon={<Inbox className="w-3.5 h-3.5" />}
                label="Без папки"
                count={counts.none}
                active={folderFilter === 'none'}
                onClick={() => onFolderFilterChange?.('none')}
              />
            )}
          </ul>

          <SectionLabel onAdd={onOpenCatalog} addLabel="Папки проектов: вступить или выйти">
            Общие папки
          </SectionLabel>
          <ul className="text-sm px-1">
            {shared.map((folder) => (
              <FolderRow
                key={folder.id}
                icon={<Folder className="w-3.5 h-3.5" />}
                label={folder.name}
                count={counts.byFolder.get(folder.id) ?? 0}
                active={folderFilter === folder.id}
                onClick={() => onFolderFilterChange?.(folder.id)}
                onSettings={() => onOpenFolder?.(folder)}
                settingsLabel={folder.canManage ? 'Настройки папки' : 'Источники и инструкции папки'}
              />
            ))}
            {shared.length === 0 && (
              <li className="px-2 py-0.5 text-xs opacity-50">
                Нажмите «+», чтобы вступить в папки своих проектов
              </li>
            )}
          </ul>

          <SectionLabel onAdd={() => onCreateFolder?.('personal')} addLabel="Создать личную папку">
            Мои папки
          </SectionLabel>
          <ul className="text-sm px-1">
            {personal.map((folder) => (
              <FolderRow
                key={folder.id}
                icon={<FolderLock className="w-3.5 h-3.5" />}
                label={folder.name}
                count={counts.byFolder.get(folder.id) ?? 0}
                active={folderFilter === folder.id}
                onClick={() => onFolderFilterChange?.(folder.id)}
                onSettings={() => onOpenFolder?.(folder)}
                settingsLabel="Настройки папки"
              />
            ))}
            {personal.length === 0 && (
              <li className="px-2 py-0.5 text-xs opacity-50">Видны только вам</li>
            )}
          </ul>
        </div>
      )}

      <div
        className={
          `flex-1 overflow-auto transition-all duration-200 ` +
          (collapsed ? 'opacity-0 -translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0')
        }
      >
        <ul className="text-sm">
          {visibleConversations.map((conversation) => (
            <li
              key={conversation.id}
              className={`px-2 py-1 cursor-pointer border-b hover:bg-muted/30 ${
                conversation.id === activeId ? 'bg-muted/50 font-medium' : ''
              }`}
              onClick={() => onSelect(conversation)}
            >
              <div className="flex items-start gap-1" title={getChatSidebarLabel(conversation.title)}>
                <span className="flex-1 truncate">{getChatSidebarLabel(conversation.title)}</span>
                <div className="flex flex-col gap-1">
                  <button
                    className="shrink-0 p-0.5 rounded hover:bg-muted"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRename(conversation);
                    }}
                    aria-label="Переименовать чат"
                  >
                    <Pencil className="w-3 h-3 opacity-70" />
                  </button>
                  {showFolders && onMoveConversation && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="shrink-0 p-0.5 rounded hover:bg-muted"
                          onClick={(event) => event.stopPropagation()}
                          aria-label="Переместить в папку"
                          title="Переместить в папку"
                          type="button"
                        >
                          <FolderInput className="w-3 h-3 opacity-70" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenuLabel>Переместить в папку</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={!conversation.folderId}
                          onSelect={() => onMoveConversation(conversation, null)}
                        >
                          <Inbox className="w-3.5 h-3.5" /> Без папки
                        </DropdownMenuItem>
                        {shared.length > 0 && <DropdownMenuSeparator />}
                        {shared.map((folder) => (
                          <DropdownMenuItem
                            key={folder.id}
                            disabled={conversation.folderId === folder.id}
                            onSelect={() => onMoveConversation(conversation, folder.id)}
                          >
                            <Folder className="w-3.5 h-3.5" /> {folder.name}
                          </DropdownMenuItem>
                        ))}
                        {personal.length > 0 && <DropdownMenuSeparator />}
                        {personal.map((folder) => (
                          <DropdownMenuItem
                            key={folder.id}
                            disabled={conversation.folderId === folder.id}
                            onSelect={() => onMoveConversation(conversation, folder.id)}
                          >
                            <FolderLock className="w-3.5 h-3.5" /> {folder.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button
                    className="shrink-0 p-0.5 rounded hover:bg-[#e0b455]/20 text-[#e0b455]"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(conversation);
                    }}
                    aria-label="Удалить чат"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="text-[10px] opacity-60 truncate">
                {formatChatListDate(conversation.created)}
              </div>
            </li>
          ))}
          {visibleConversations.length === 0 && (
            <li className="px-2 py-2 text-xs opacity-60">
              {conversations.length === 0 || !showFolders || folderFilter === 'all'
                ? 'Нет сохранённых чатов'
                : 'В этой папке у вас пока нет чатов — нажмите «Новый»'}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
};
