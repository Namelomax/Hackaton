'use client';

import { Dispatch, FormEvent, SetStateAction, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type AuthUser = { id: string; username: string } | null;

type HeaderProps = {
  authUser: AuthUser;
  authUsername: string;
  authPassword: string;
  authMode: 'login' | 'register';
  onAuth: () => void;
  onLogout: () => void;
  setAuthUsername: Dispatch<SetStateAction<string>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setAuthMode: Dispatch<SetStateAction<'login' | 'register'>>;
  toggleAuthMode: () => void;
  brandLabel?: string;
};

export const Header = ({
  authUser,
  authUsername,
  authPassword,
  authMode,
  onAuth,
  onLogout,
  setAuthUsername,
  setAuthPassword,
  setAuthMode,
  toggleAuthMode,
  brandLabel = 'Регламентер',
}: HeaderProps) => {
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    if (authUser) {
      setAuthOpen(false);
    }
  }, [authUser]);

  const openAuthModal = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onAuth();
  };

  return (
    <div className="p-3 border-b bg-muted/5">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">{brandLabel}</div>
        <div>
          {authUser ? (
            <div className="flex items-center gap-3">
              <div className="text-sm">
                Signed in as <strong>{authUser.username}</strong>
              </div>
              <button onClick={onLogout} className="text-sm px-2 py-1 border rounded">
                Logout
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => openAuthModal('login')}
                className="text-sm px-3 py-1 border rounded"
              >
                Войти
              </button>
              <button
                onClick={() => openAuthModal('register')}
                className="text-sm px-3 py-1 bg-primary text-black rounded"
              >
                Регистрация
              </button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={authOpen} onOpenChange={setAuthOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {authMode === 'login' ? 'Вход в аккаунт' : 'Регистрация'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-neutral-300">Логин</label>
              <input
                className="w-full border border-neutral-700 bg-neutral-900 text-white px-3 py-2 rounded text-sm"
                placeholder="Введите логин"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-300">Пароль</label>
              <input
                className="w-full border border-neutral-700 bg-neutral-900 text-white px-3 py-2 rounded text-sm"
                type="password"
                placeholder="Введите пароль"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={toggleAuthMode}
                className="text-xs text-neutral-300 hover:text-white"
              >
                {authMode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
              </button>
              <button
                type="submit"
                className="text-sm px-4 py-2 bg-white text-black rounded"
              >
                {authMode === 'login' ? 'Войти' : 'Создать'}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
