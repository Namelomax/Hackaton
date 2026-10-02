'use client';

import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const MIN_LENGTH = 8;

/** Смена своего пароля — прежде всего временного, выданного администратором. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pending, setPending] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setRepeat('');
  };

  const problem =
    next.length > 0 && next.length < MIN_LENGTH
      ? `Не короче ${MIN_LENGTH} символов`
      : repeat.length > 0 && repeat !== next
        ? 'Пароли не совпадают'
        : null;
  const canSubmit = !pending && current.length > 0 && next.length >= MIN_LENGTH && next === repeat;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    try {
      const resp = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change-password', currentPassword: current, newPassword: next }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось сменить пароль');
      toast.success('Пароль изменён');
      reset();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const inputClass = 'w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Смена пароля</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="pw-current">Текущий пароль</label>
              <input id="pw-current" type="password" autoComplete="current-password" className={inputClass} value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="pw-new">Новый пароль</label>
              <input id="pw-new" type="password" autoComplete="new-password" className={inputClass} value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="pw-repeat">Повторите новый пароль</label>
              <input id="pw-repeat" type="password" autoComplete="new-password" className={inputClass} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </div>
          </fieldset>
          {problem && <p className="text-xs text-red-700">{problem}</p>}
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={!canSubmit} className="text-sm px-4 py-2 bg-primary text-black rounded disabled:opacity-60">
              {pending ? 'Сохраняем…' : 'Сменить пароль'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
