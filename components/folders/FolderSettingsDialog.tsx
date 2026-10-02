'use client';

import { FileText, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FolderMembers } from './FolderMembers';
import type { ClientFolder } from './types';

const INSTRUCTIONS_MAX = 8000;

type SourceItem = { id: string; filename: string; status?: string; chunks_count?: number | null };

type Props = {
  folder: ClientFolder | null;
  onClose: () => void;
  onSaved: (folder: ClientFolder) => void;
  onDeleted: (folderId: string) => void;
  /** Пользователь вышел из общей папки (его чаты сервер перенёс в «Без папки»). */
  onLeft?: (folderId: string) => void;
  /** Состав участников изменил админ — счётчики и, возможно, свой сайдбар. */
  onMembersChanged?: (folderId: string, memberIds: string[]) => void;
  /** Поиск по документам настроен на сервере. Нет — раздела источников нет вовсе. */
  sourcesEnabled?: boolean;
};

/**
 * Настройки папки: название, инструкции проекта и источники (файлы проекта).
 * Источники показываются, только если на сервере включён поиск по документам.
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
  sourcesEnabled = false,
}: Props) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);
  const [sources, setSources] = useState<SourceItem[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canManage = Boolean(folder?.canManage);

  const loadSources = useCallback(async (folderId: string) => {
    setSourcesError(null);
    try {
      const resp = await fetch(`/api/folders/sources?folderId=${encodeURIComponent(folderId)}`);
      const j = await resp.json().catch(() => null);
      if (!resp.ok) {
        setSources([]);
        setSourcesError('Не удалось загрузить список источников');
        return;
      }
      setSources(Array.isArray(j) ? j : []);
    } catch {
      setSources([]);
      setSourcesError('Не удалось загрузить список источников');
    }
  }, []);

  useEffect(() => {
    if (!folder) return;
    setName(folder.name);
    setInstructions(folder.instructions ?? '');
    setSources(null);
    if (sourcesEnabled) void loadSources(folder.id);
  }, [folder, loadSources, sourcesEnabled]);

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

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch(`/api/folders/sources?folderId=${encodeURIComponent(folder.id)}`, {
          method: 'POST',
          body: form,
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          toast.error(`«${file.name}» не загружен`, { description: j?.error || j?.message || `HTTP ${resp.status}` });
        } else {
          toast.success(j?.deduplicated ? `«${file.name}» уже был в источниках` : `«${file.name}» добавлен`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      void loadSources(folder.id);
    }
  };

  const removeSource = (item: SourceItem) => {
    toast(`Удалить источник «${item.filename}»?`, {
      action: {
        label: 'Удалить',
        onClick: async () => {
          const resp = await fetch('/api/folders/sources', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId: folder.id, id: item.id }),
          });
          if (!resp.ok) toast.error('Не удалось удалить источник');
          void loadSources(folder.id);
        },
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
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

          {sourcesEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-600">Источники</span>
              {canManage && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,.docx,.doc,.txt,.md,.xlsx,.pptx"
                    onChange={(e) => void upload(e.target.files)}
                  />
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-neutral-300 rounded hover:bg-neutral-100 disabled:opacity-60"
                  >
                    <Upload className="w-3 h-3" />
                    {uploading ? 'Индексируем…' : 'Добавить файлы'}
                  </button>
                </>
              )}
            </div>
            {sources === null ? (
              <p className="text-xs text-neutral-500">Загрузка…</p>
            ) : sourcesError ? (
              <p className="text-xs text-amber-700">{sourcesError}</p>
            ) : sources.length === 0 ? (
              <p className="text-xs text-neutral-500">Источников пока нет</p>
            ) : (
              <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
                {sources.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <FileText className="w-4 h-4 shrink-0 text-neutral-500" />
                    <span className="flex-1 truncate" title={item.filename}>
                      {item.filename}
                    </span>
                    {item.status && item.status !== 'processed' && (
                      <span className="text-[10px] text-neutral-500">{item.status}</span>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => removeSource(item)}
                        className="p-1 rounded hover:bg-neutral-100"
                        aria-label={`Удалить источник ${item.filename}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-neutral-500" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-neutral-500">
              Регламенты, справочники, прошлые договорённости по проекту. Протоколер ищет в них
              фрагменты по ходу каждого чата папки.
            </p>
          </div>
          )}

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
