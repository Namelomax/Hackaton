'use client';

import { ArrowLeft, Copy, KeyRound, Lock, LockOpen, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Role = 'admin' | 'user';

type AdminUser = {
  id: string;
  username: string;
  role: Role;
  blocked: boolean;
  /** active — пароль задан; pending — ждёт первого входа; expired — приглашение истекло. */
  state: 'active' | 'pending' | 'expired';
  inviteExpiresAt: string | null;
  roleFromEnv: boolean;
  created: string;
  conversationsCount: number;
  lastLogin: string | null;
  lastChatActivity: string | null;
};

type Me = { id: string; username: string; role: Role };

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(String(value).replace(/^d'|'$/g, ''));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDay(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}

/** Что отправить пользователю, которого завели или кому сбросили пароль. */
function inviteMessage(username: string): string {
  return [
    `Вам открыт доступ к Протоколеру: ${window.location.origin}`,
    `Логин: ${username}`,
    'При первом входе введите только логин и нажмите «Войти» — система предложит придумать пароль.',
  ].join('\n');
}

async function copyInvite(username: string) {
  try {
    await navigator.clipboard.writeText(inviteMessage(username));
    toast.success('Текст приглашения скопирован');
  } catch {
    toast.error('Не удалось скопировать — передайте логин пользователю вручную');
  }
}

const inputClass = 'w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm';

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const resp = await fetch('/api/admin/users');
    if (resp.status === 401 || resp.status === 403) {
      setState('denied');
      return;
    }
    const j = await resp.json().catch(() => null);
    if (!j?.success) {
      setState('error');
      return;
    }
    setUsers(j.users);
    setState('ready');
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/auth');
        const j = await resp.json().catch(() => null);
        if (!j?.success || j.user?.role !== 'admin') {
          setState('denied');
          return;
        }
        setMe(j.user);
        await loadUsers();
      } catch {
        setState('error');
      }
    })();
  }, [loadUsers]);

  const patchUser = async (user: AdminUser, patch: Partial<{ role: Role; blocked: boolean; resetPassword: true }>) => {
    setBusyId(user.id);
    try {
      const resp = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, ...patch }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось изменить пользователя');
      await loadUsers();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleBlocked = (user: AdminUser) => {
    if (user.blocked) {
      void patchUser(user, { blocked: false }).then((ok) => ok && toast.success(`${user.username}: доступ открыт`));
      return;
    }
    toast(`Заблокировать ${user.username}?`, {
      description: 'Пользователь сразу потеряет доступ, его чаты сохранятся.',
      action: {
        label: 'Заблокировать',
        onClick: () => void patchUser(user, { blocked: true }).then((ok) => ok && toast.success(`${user.username} заблокирован`)),
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  const changeRole = (user: AdminUser, role: Role) => {
    void patchUser(user, { role }).then(
      (ok) => ok && toast.success(`${user.username}: ${role === 'admin' ? 'администратор' : 'пользователь'}`),
    );
  };

  const resetPassword = (user: AdminUser) => {
    toast(`Сбросить пароль ${user.username}?`, {
      description:
        'Старый пароль перестанет работать, при следующем входе пользователь придумает новый. ' +
        'Уже открытые сессии не завершаются — чтобы закрыть доступ сразу, заблокируйте учётку.',
      action: {
        label: 'Сбросить',
        onClick: () =>
          void patchUser(user, { resetPassword: true }).then((ok) => {
            if (!ok) return;
            toast.success(`Пароль ${user.username} сброшен`, {
              description: 'Сообщите пользователю: войти с логином без пароля и придумать новый.',
              action: { label: 'Скопировать текст', onClick: () => void copyInvite(user.username) },
            });
          }),
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  const removeUser = (user: AdminUser) => {
    toast(`Удалить ${user.username}?`, {
      description: `Вместе с учётной записью удалятся все его чаты (${user.conversationsCount}) и личные папки. Отменить нельзя.`,
      action: {
        label: 'Удалить',
        onClick: async () => {
          setBusyId(user.id);
          try {
            const resp = await fetch('/api/admin/users', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: user.id }),
            });
            const j = await resp.json().catch(() => ({}));
            if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось удалить');
            toast.success(`${user.username} удалён`);
            await loadUsers();
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusyId(null);
          }
        },
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  if (state === 'loading') {
    return <div className="p-8 text-sm text-muted-foreground">Загрузка…</div>;
  }
  if (state === 'denied') {
    return (
      <div className="p-8 space-y-3">
        <p className="text-sm">Раздел доступен только администраторам.</p>
        <a href="/" className="text-sm underline">
          Вернуться к протоколеру
        </a>
      </div>
    );
  }
  if (state === 'error') {
    return <div className="p-8 text-sm text-red-700">Не удалось загрузить данные. Обновите страницу.</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="p-3 border-b bg-muted/5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <a href="/" className="inline-flex items-center gap-1 text-sm px-2 py-1 border rounded hover:bg-muted/30">
            <ArrowLeft className="w-4 h-4" /> К протоколеру
          </a>
          <h1 className="text-sm font-semibold">Администрирование</h1>
        </div>
        <div className="text-sm">
          Вы вошли как <strong>{me?.username}</strong>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Пользователи</h2>
            <p className="text-xs text-muted-foreground">
              Содержимое чатов пользователей администратору не показывается — только количество и активность.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 bg-primary text-black rounded"
          >
            <UserPlus className="w-4 h-4" /> Добавить пользователя
          </button>
        </div>

        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">Логин</th>
                <th className="px-3 py-2 font-medium">Роль</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium text-right">Чатов</th>
                <th className="px-3 py-2 font-medium">Последний вход</th>
                <th className="px-3 py-2 font-medium">Активность в чатах</th>
                <th className="px-3 py-2 font-medium">Создан</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const isMe = me?.id === user.id;
                const locked = isMe || user.roleFromEnv;
                const lockReason = isMe
                  ? 'Свою учётную запись менять здесь нельзя'
                  : 'Администратор задан в ADMIN_USERNAMES — меняется только в конфигурации сервера';
                const busy = busyId === user.id;
                return (
                  <tr key={user.id} className={`border-t ${user.blocked ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2">
                      {user.username}
                      {isMe && <span className="ml-1 text-xs text-muted-foreground">(вы)</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="border rounded px-1.5 py-0.5 text-sm bg-background disabled:opacity-60"
                        value={user.role}
                        disabled={locked || busy}
                        title={locked ? lockReason : undefined}
                        onChange={(e) => changeRole(user, e.target.value as Role)}
                      >
                        <option value="user">Пользователь</option>
                        <option value="admin">Администратор</option>
                      </select>
                      {user.roleFromEnv && (
                        <span className="ml-1 inline-flex align-middle" title={lockReason}>
                          <ShieldCheck className="w-3.5 h-3.5 text-muted-foreground" />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {user.blocked ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800">Заблокирован</span>
                      ) : user.state === 'pending' ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                          title="Пароль ещё не придуман. Пока его нет, войти под этим логином может любой, кто его знает, — сообщите логин пользователю сразу."
                        >
                          Ждёт первого входа{user.inviteExpiresAt ? ` · до ${formatDay(user.inviteExpiresAt)}` : ''}
                        </span>
                      ) : user.state === 'expired' ? (
                        <span
                          className="text-xs px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-700"
                          title="Пользователь не вошёл вовремя. Сбросьте пароль — приглашение начнётся заново."
                        >
                          Приглашение истекло
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800">Активен</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{user.conversationsCount}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(user.lastLogin)}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(user.lastChatActivity)}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(user.created)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {user.state === 'pending' && (
                          <button
                            type="button"
                            onClick={() => void copyInvite(user.username)}
                            className="p-1 rounded hover:bg-muted"
                            title="Скопировать текст приглашения"
                            aria-label={`Скопировать приглашение для ${user.username}`}
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={locked || busy}
                          onClick={() => resetPassword(user)}
                          className="p-1 rounded hover:bg-muted disabled:opacity-40"
                          title={locked ? lockReason : 'Сбросить пароль — пользователь придумает новый при входе'}
                          aria-label={`Сбросить пароль ${user.username}`}
                        >
                          <KeyRound className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          disabled={locked || busy}
                          onClick={() => toggleBlocked(user)}
                          className="p-1 rounded hover:bg-muted disabled:opacity-40"
                          title={locked ? lockReason : user.blocked ? 'Разблокировать' : 'Заблокировать'}
                          aria-label={user.blocked ? `Разблокировать ${user.username}` : `Заблокировать ${user.username}`}
                        >
                          {user.blocked ? <LockOpen className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                        </button>
                        <button
                          type="button"
                          disabled={locked || busy}
                          onClick={() => removeUser(user)}
                          className="p-1 rounded hover:bg-red-50 text-red-700 disabled:opacity-40"
                          title={locked ? lockReason : 'Удалить пользователя и его чаты'}
                          aria-label={`Удалить ${user.username}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Пароли администратор не задаёт и не знает: новый пользователь при первом входе вводит только
          логин и сам придумывает пароль. Приглашение действует 14 дней.
        </p>
        <p className="text-xs text-muted-foreground">
          Общие папки проектов создаются на главной странице: «Общие папки» → «+». Участников можно
          добавить в настройках папки, а пользователи и сами вступают в нужные папки через каталог.
        </p>
      </div>

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await loadUsers();
        }}
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setUsername('');
      setRole('user');
    }
  }, [open]);

  const canSubmit = !pending && username.trim().length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    try {
      const resp = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, role }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) throw new Error(j?.message || 'Не удалось создать пользователя');
      const created = j.user.username as string;
      toast.success(`Пользователь ${created} добавлен`, {
        description: 'Сообщите ему логин: при первом входе он сам придумает пароль.',
        action: { label: 'Скопировать текст', onClick: () => void copyInvite(created) },
        duration: 15000,
      });
      await onCreated();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый пользователь</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <fieldset disabled={pending} className="space-y-3 disabled:opacity-60">
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="new-username">Логин</label>
              <input
                id="new-username"
                className={inputClass}
                value={username}
                maxLength={64}
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-600" htmlFor="new-role">Роль</label>
              <select id="new-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="user">Пользователь</option>
                <option value="admin">Администратор</option>
              </select>
            </div>
          </fieldset>
          <p className="text-xs text-neutral-600">
            Пароль задавать не нужно: при первом входе пользователь введёт логин и придумает пароль сам.
            Пока он этого не сделал, войти под логином может любой, кто его знает, поэтому сообщите логин
            сразу. Приглашение действует 14 дней.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 border border-neutral-300 rounded">
              Отмена
            </button>
            <button type="submit" disabled={!canSubmit} className="text-sm px-4 py-1.5 bg-primary text-black rounded disabled:opacity-60">
              {pending ? 'Добавляем…' : 'Добавить'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
