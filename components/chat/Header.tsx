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
  brandLabel = 'Протоколёр',
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
      <div className="w-full flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="h-8 w-90 shrink-0 overflow-visible">
            <img
              src="/logo.jpg"
              alt="Логотип"
              className="h-8 w-8 object-contain scale-250 origin-left"
            />
          </div>
          <div className="text-sm text-foreground font-semibold">{brandLabel}</div>
        </div>
        <div>
          {authUser ? (
            <div className="flex items-center gap-3">
              <div className="text-sm">
                Вы вошли как <strong>{authUser.username}</strong>
              </div>
              <button onClick={onLogout} className="text-sm px-3 py-1 bg-primary text-primary-foreground rounded">
                Выйти
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
              <label className="text-xs text-neutral-600">Логин</label>
              <input
                className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
                placeholder="Введите логин"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-neutral-600">Пароль</label>
              <input
                className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm"
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
                className="text-xs text-neutral-600 hover:text-black"
              >
                {authMode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
              </button>
              <button
                type="submit"
                className="text-sm px-4 py-2 bg-primary text-black rounded"
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
