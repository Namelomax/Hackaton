'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FolderMembers } from './FolderMembers';
import type { ClientFolder } from './types';

const INSTRUCTIONS_MAX = 8000;

type Props = {
  folder: ClientFolder | null;
  onClose: () => void;
  onSaved: (folder: ClientFolder) => void;
  onDeleted: (folderId: string) => void;
  /** Пользователь вышел из общей папки (его чаты сервер перенёс в «Без папки»). */
  onLeft?: (folderId: string) => void;
  /** Состав участников изменил админ — счётчики и, возможно, свой сайдбар. */
  onMembersChanged?: (folderId: string, memberIds: string[]) => void;
};

/**
 * Настройки папки: название и инструкции проекта.
 * Кто не управляет папкой, видит то же самое только для чтения — чтобы
 * понимать, какой контекст протоколер подмешивает в его чаты.
 */
export function FolderSettingsDialog({
  folder,
  onClose,
  onSaved,
  onDeleted,
  onLeft,
  onMembersChanged,
}: Props) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);

  const canManage = Boolean(folder?.canManage);

  useEffect(() => {
    if (!folder) return;
    setName(folder.name);
    setInstructions(folder.instructions ?? '');
  }, [folder]);

  if (!folder) return null;

  const dirty = name.trim() !== folder.name || instructions !== (folder.instructions ?? '');

  const save = async () => {
    if (!name.trim()) {
      toast.error('Название папки не может быть пустым');
      return;
    }
    setSaving(true);
    try {
      const resp = await fetch('/api/folders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, name, instructions }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось сохранить');
      onSaved(j.folder);
      toast.success('Папка сохранена');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const leaveFolder = () => {
    toast(`Выйти из папки «${folder.name}»?`, {
      description: 'Ваши чаты из неё не удалятся — переедут в «Без папки». Вернуться можно через каталог папок.',
      action: {
        label: 'Выйти',
        onClick: async () => {
          const resp = await fetch('/api/folders/membership', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: folder.id, action: 'leave' }),
          });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || !j?.success) {
            toast.error(j?.message || 'Не удалось выйти из папки');
            return;
          }
          onLeft?.(folder.id);
          toast.success(`Вы вышли из папки «${folder.name}»`);
        },
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  const removeFolder = () => {
    toast(`Удалить папку «${folder.name}»?`, {
      description: 'Чаты не удаляются: у владельцев они переместятся в «Без папки».',
      action: {
        label: 'Удалить',
        onClick: async () => {
          const resp = await fetch('/api/folders', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: folder.id }),
          });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || !j?.success) {
            toast.error(j?.message || 'Не удалось удалить папку');
            return;
          }
          onDeleted(folder.id);
          toast.success('Папка удалена');
        },
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  return (
    <Dialog open={Boolean(folder)} onOpenChange={(open) => !open && onClose()} panelClassName="max-w-2xl">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {folder.kind === 'shared' ? 'Общая папка' : 'Личная папка'}: {folder.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {!canManage && (
            <p className="text-xs text-neutral-600">
              Общими папками управляет администратор. Здесь видно, какой контекст протоколер
              использует в ваших чатах этой папки.
            </p>
          )}

          {canManage && (
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="folder-name">
                Название
              </label>
              <input
                id="folder-name"
                className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-neutral-600" htmlFor="folder-instructions">
                Инструкции проекта
              </label>
              {canManage && (
                <span className="text-[10px] text-neutral-500">
                  {instructions.length} / {INSTRUCTIONS_MAX}
                </span>
              )}
            </div>
            {canManage ? (
              <textarea
                id="folder-instructions"
                className="w-full min-h-[140px] border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
                placeholder={
                  'Что протоколеру стоит знать о проекте: заказчик и исполнитель, кто обычно ' +
                  'подписывает протокол, принятые сокращения и термины.'
                }
                value={instructions}
                maxLength={INSTRUCTIONS_MAX}
                onChange={(e) => setInstructions(e.target.value)}
              />
            ) : (
              <div className="whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-black">
                {folder.instructions?.trim() || <span className="text-neutral-500">Инструкций нет</span>}
              </div>
            )}
            <p className="text-[11px] text-neutral-500">
              Подмешиваются в каждый чат этой папки как справка о проекте. Факты самой встречи
              протоколер по-прежнему берёт только из расшифровки.
            </p>
          </div>

          {folder.kind === 'shared' && folder.canManageMembers && (
            <FolderMembers
              folderId={folder.id}
              onChanged={(members) =>
                onMembersChanged?.(
                  folder.id,
                  members.map((m) => m.id),
                )
              }
            />
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          {canManage ? (
            <button
              type="button"
              onClick={removeFolder}
              className="text-xs text-red-700 hover:underline"
            >
              Удалить папку
            </button>
          ) : folder.kind === 'shared' && folder.isMember ? (
            <button type="button" onClick={leaveFolder} className="text-xs text-neutral-700 hover:underline">
              Выйти из папки
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 border border-neutral-300 rounded">
              Закрыть
            </button>
            {canManage && (
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => void save()}
                className="text-sm px-3 py-1.5 bg-primary text-black rounded disabled:opacity-60"
              >
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
