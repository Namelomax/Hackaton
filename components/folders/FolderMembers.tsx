'use client';

import { UserMinus, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type Member = { id: string; username: string };

/**
 * Участники общей папки — блок для администратора в настройках папки.
 * Убранный участник не теряет чаты: сервер переносит их в «Без папки».
 */
export function FolderMembers({
  folderId,
  onChanged,
}: {
  folderId: string;
  /** Состав изменился — например, чтобы обновить счётчик в каталоге или свой сайдбар. */
  onChanged?: (members: Member[]) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [allUsers, setAllUsers] = useState<Member[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [m, u] = await Promise.all([
      fetch(`/api/folders/members?folderId=${encodeURIComponent(folderId)}`).then((r) => r.json()).catch(() => null),
      fetch('/api/admin/users').then((r) => r.json()).catch(() => null),
    ]);
    setMembers(m?.success ? m.members : []);
    setAllUsers(
      u?.success
        ? (u.users as Array<Member & { blocked?: boolean }>)
            .filter((x) => !x.blocked)
            .map((x) => ({ id: x.id, username: x.username }))
        : [],
    );
  }, [folderId]);

  useEffect(() => {
    setMembers(null);
    setSelected('');
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    const inFolder = new Set((members ?? []).map((m) => m.id));
    return allUsers.filter((u) => !inFolder.has(u.id)).sort((a, b) => a.username.localeCompare(b.username, 'ru'));
  }, [allUsers, members]);

  const change = async (method: 'POST' | 'DELETE', userId: string) => {
    setBusy(true);
    try {
      const resp = await fetch('/api/folders/members', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, userId }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось изменить участников');
      setMembers(j.members);
      setSelected('');
      onChanged?.(j.members);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = (member: Member) => {
    toast(`Убрать ${member.username} из папки?`, {
      description: 'Его чаты из этой папки не удалятся — переедут в «Без папки».',
      action: { label: 'Убрать', onClick: () => void change('DELETE', member.id) },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  return (
    <div className="space-y-2">
      <span className="text-xs text-neutral-600">Участники</span>
      <div className="flex gap-2">
        <select
          className="flex-1 border border-neutral-300 bg-white text-black px-2 py-1 rounded text-sm"
          value={selected}
          disabled={busy || candidates.length === 0}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Пользователь для добавления"
        >
          <option value="">{candidates.length === 0 ? 'Все пользователи уже в папке' : 'Выберите пользователя'}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selected || busy}
          onClick={() => void change('POST', selected)}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-neutral-300 rounded hover:bg-neutral-100 disabled:opacity-60"
        >
          <UserPlus className="w-3.5 h-3.5" /> Добавить
        </button>
      </div>
      {members === null ? (
        <p className="text-xs text-neutral-500">Загрузка…</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-neutral-500">В папке пока никого. Пользователи могут вступить сами через каталог.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="flex-1 truncate">{m.username}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(m)}
                className="p-1 rounded hover:bg-neutral-100 disabled:opacity-60"
                aria-label={`Убрать ${m.username} из папки`}
                title="Убрать из папки"
              >
                <UserMinus className="w-3.5 h-3.5 text-neutral-500" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
