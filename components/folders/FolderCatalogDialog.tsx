'use client';

import { Check, Folder, Plus, Settings2, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ClientFolder } from './types';

type Props = {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  /** Участие изменилось — перечитать папки сайдбара. */
  onMembershipChanged: (folder: ClientFolder, joined: boolean) => void;
  onOpenSettings: (folder: ClientFolder) => void;
  onCreateShared: () => void;
};

/**
 * Каталог общих папок проектов. Пользователь сам вступает в нужные и выходит
 * из ненужных — в сайдбаре остаются только его проекты (решение заказчика от
 * 02.10.2026). Администратор отсюда же открывает настройки любой папки.
 */
export function FolderCatalogDialog({ open, onClose, isAdmin, onMembershipChanged, onOpenSettings, onCreateShared }: Props) {
  const [folders, setFolders] = useState<ClientFolder[] | null>(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch('/api/folders?scope=catalog');
      const j = await resp.json().catch(() => null);
      setFolders(j?.success ? j.folders : []);
    } catch {
      setFolders([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setFolders(null);
      void load();
    }
  }, [open, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = folders ?? [];
    return q ? list.filter((f) => f.name.toLowerCase().includes(q)) : list;
  }, [folders, query]);

  const setMembership = async (folder: ClientFolder, join: boolean) => {
    setBusyId(folder.id);
    try {
      const resp = await fetch('/api/folders/membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, action: join ? 'join' : 'leave' }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось изменить участие');
      setFolders((prev) => (prev ?? []).map((f) => (f.id === folder.id ? j.folder : f)));
      onMembershipChanged(j.folder, join);
      toast.success(join ? `Вы в папке «${folder.name}»` : `Вы вышли из папки «${folder.name}»`, {
        description: join ? undefined : 'Ваши чаты из неё перенесены в «Без папки».',
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const leave = (folder: ClientFolder) => {
    toast(`Выйти из папки «${folder.name}»?`, {
      description: 'Ваши чаты из неё не удалятся — они переедут в «Без папки». Вернуться можно в любой момент.',
      action: { label: 'Выйти', onClick: () => void setMembership(folder, false) },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} panelClassName="max-w-xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Папки проектов</DialogTitle>
        </DialogHeader>
        <p className="mb-3 text-xs text-neutral-600">
          Вступите в папки проектов, с которыми работаете, — они появятся в боковой панели. Чаты в папке
          видите только вы; общими для участников остаются инструкции и источники проекта.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 border border-neutral-300 bg-white text-black px-3 py-1.5 rounded text-sm"
            placeholder="Поиск по названию"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isAdmin && (
            <button
              type="button"
              onClick={onCreateShared}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 bg-primary text-black rounded"
            >
              <Plus className="w-4 h-4" /> Создать
            </button>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto rounded border border-neutral-200">
          {folders === null ? (
            <p className="p-3 text-xs text-neutral-500">Загрузка…</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-xs text-neutral-500">
              {folders.length === 0
                ? isAdmin
                  ? 'Папок проектов пока нет — создайте первую.'
                  : 'Папок проектов пока нет — их создаёт администратор.'
                : 'Ничего не нашлось'}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200">
              {visible.map((folder) => (
                <li key={folder.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Folder className="w-4 h-4 shrink-0 text-neutral-500" />
                  <span className="flex-1 truncate" title={folder.name}>
                    {folder.name}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-neutral-500" title="Участников">
                    <Users className="w-3 h-3" />
                    {folder.memberCount ?? 0}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => onOpenSettings(folder)}
                      className="p-1 rounded hover:bg-neutral-100"
                      title="Настройки и участники"
                      aria-label={`Настройки папки ${folder.name}`}
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {folder.isMember ? (
                    <button
                      type="button"
                      disabled={busyId === folder.id}
                      onClick={() => leave(folder)}
                      className="group inline-flex w-28 justify-center items-center gap-1 text-xs px-2 py-1 border border-neutral-300 rounded hover:border-red-300 hover:text-red-700 disabled:opacity-60"
                    >
                      <Check className="w-3 h-3 group-hover:hidden" />
                      <span className="group-hover:hidden">Вы участник</span>
                      <span className="hidden group-hover:inline">Выйти</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === folder.id}
                      onClick={() => void setMembership(folder, true)}
                      className="w-28 text-xs px-2 py-1 bg-primary text-black rounded disabled:opacity-60"
                    >
                      Вступить
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 border border-neutral-300 rounded">
            Закрыть
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
