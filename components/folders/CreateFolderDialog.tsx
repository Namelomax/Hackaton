'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ClientFolder } from './types';

const INSTRUCTIONS_MAX = 8000;

/** Создание папки: название обязательно, инструкции — по желанию. */
export function CreateFolderDialog({
  kind,
  onClose,
  onCreated,
}: {
  /** null — окно закрыто. */
  kind: 'shared' | 'personal' | null;
  onClose: () => void;
  onCreated: (folder: ClientFolder) => void;
}) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (kind) {
      setName('');
      setInstructions('');
    }
  }, [kind]);

  if (!kind) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    try {
      const resp = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind, instructions }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось создать папку');
      onCreated(j.folder);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'shared' ? 'Новая папка проекта' : 'Новая личная папка'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="folder-new-name">
                Название
              </label>
              <input
                id="folder-new-name"
                className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
                value={name}
                maxLength={120}
                // biome-ignore lint/a11y/noAutofocus: окно открывается ради этого поля
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="folder-new-instructions">
                Инструкции проекта <span className="text-neutral-400">— необязательно</span>
              </label>
              <textarea
                id="folder-new-instructions"
                className="w-full min-h-[100px] border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
                placeholder="Заказчик и исполнитель, кто подписывает протоколы, принятые сокращения. Можно добавить позже в настройках папки."
                value={instructions}
                maxLength={INSTRUCTIONS_MAX}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>
            {kind === 'personal' && (
              <p className="text-xs text-neutral-500">Личную папку видите только вы.</p>
            )}
          </fieldset>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 border border-neutral-300 rounded">
              Отмена
            </button>
            <button
              type="submit"
              disabled={!name.trim() || pending}
              className="text-sm px-4 py-1.5 bg-primary text-black rounded disabled:opacity-60"
            >
              {pending ? 'Создаём…' : 'Создать'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
