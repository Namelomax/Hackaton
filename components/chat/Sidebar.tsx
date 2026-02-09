'use client';

import { ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';

type Conversation = {
  id: string;
  title?: string | null;
  created?: string | null;
  messages?: any[];
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
};

export const Sidebar = ({
  conversations,
  activeId,
  onSelect,
  onNewLocal,
  onRename,
  onDelete,
  collapsed,
  onToggleCollapsed,
}: SidebarProps) => {
  return (
    <div
      className={
        `border-r flex flex-col shrink-0 bg-muted/10 overflow-hidden ` +
        `transition-[width] duration-200 ease-in-out ` +
        (collapsed ? 'w-10' : 'w-42')
      }
    >
      <div className="relative p-2 flex items-center justify-between border-b">
        <div
          className={
            `flex items-center justify-between w-full transition-all duration-200 ` +
            (collapsed ? 'opacity-0 -translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0')
          }
        >
          <span className="text-xs font-medium">Ваши чаты</span>
          <div className="flex items-center gap-2">
            <button onClick={onNewLocal} className="text-xs px-2 py-1 border rounded" type="button">
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

      <div
        className={
          `flex-1 overflow-auto transition-all duration-200 ` +
          (collapsed ? 'opacity-0 -translate-x-2 pointer-events-none' : 'opacity-100 translate-x-0')
        }
      >
        <ul className="text-sm">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={`px-2 py-1 cursor-pointer border-b hover:bg-muted/30 ${
                conversation.id === activeId ? 'bg-muted/50 font-medium' : ''
              }`}
              onClick={() => onSelect(conversation)}
            >
              <div className="flex items-start gap-1" title={conversation.title || 'Чат'}>
                <span className="flex-1 truncate">{conversation.title || 'Чат'}</span>
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
                {conversation.created?.slice(0, 19)}
              </div>
            </li>
          ))}
          {conversations.length === 0 && (
            <li className="px-2 py-2 text-xs opacity-60">Нет сохранённых чатов</li>
          )}
        </ul>
      </div>
    </div>
  );
};
