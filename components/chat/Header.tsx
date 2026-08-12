'use client';

import { Dispatch, FormEvent, SetStateAction, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type AuthUser = { id: string; username: string } | null;

type HeaderProps = {
  authUser: AuthUser;
  authUsername: string;
  authPassword: string;
  authMode: 'login' | 'register';
  authOpen: boolean;
  setAuthOpen: (open: boolean) => void;
  onAuth: () => void;
  /** Запрос входа/регистрации в полёте — блокируем форму и показываем прогресс. */
  authPending?: boolean;
  onLogout: () => void;
  setAuthUsername: Dispatch<SetStateAction<string>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setAuthMode: Dispatch<SetStateAction<'login' | 'register'>>;
  toggleAuthMode: () => void;
  brandLabel?: string;
  showAuthHint?: boolean;
  anonymizeMode?: boolean;
  onToggleAnonymize?: (next: boolean) => void;
  /** Показывать окно подтверждения перед отправкой в облако (анонимизация идёт всегда). */
  anonymizeConfirm?: boolean;
  onToggleAnonymizeConfirm?: (next: boolean) => void;
};

export const Header = ({
  authUser,
  authUsername,
  authPassword,
  authMode,
  authOpen,
  setAuthOpen,
  onAuth,
  authPending = false,
  onLogout,
  setAuthUsername,
  setAuthPassword,
  setAuthMode,
  toggleAuthMode,
  brandLabel = 'Протоколёр',
  showAuthHint = false,
  anonymizeMode = false,
  onToggleAnonymize,
  anonymizeConfirm = true,
  onToggleAnonymizeConfirm,
}: HeaderProps) => {
  useEffect(() => {
    if (authUser) {
      setAuthOpen(false);
    }
  }, [authUser, setAuthOpen]);

  const openAuthModal = (mode: 'login' | 'register') => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authPending) return;
    onAuth();
  };

  const canSubmit = !authPending && authUsername.trim().length > 0 && authPassword.length > 0;
  const submitLabel = authMode === 'login' ? 'Войти' : 'Создать';
  const pendingLabel = authMode === 'login' ? 'Входим…' : 'Создаём…';

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

        {/* Переключатель режима работы LLM */}
        <div
          className="flex items-center rounded-lg border bg-background p-0.5 text-xs shadow-sm"
          role="group"
          aria-label="Режим работы модели"
        >
          <button
            type="button"
            onClick={() => onToggleAnonymize?.(false)}
            title="Локальная LLM на сервере (данные не покидают контур). Качество ниже."
            className={`px-3 py-1.5 rounded-md transition-colors ${
              !anonymizeMode
                ? 'bg-primary text-black font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            🖥️ Локальная LLM
          </button>
          <button
            type="button"
            onClick={() => onToggleAnonymize?.(true)}
            title="Облачная LLM. Документ и сообщения анонимизируются перед отправкой — без ПДн (152-ФЗ)."
            className={`px-3 py-1.5 rounded-md transition-colors ${
              anonymizeMode
                ? 'bg-primary text-black font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            ☁️ Облако + анонимизация
          </button>
        </div>

        {/* Подтверждение анонимизации: скрывает окно предпросмотра. Сама
            анонимизация выполняется всегда — этот флаг на неё не влияет. */}
        {anonymizeMode && (
          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none"
            title="Показывать окно с анонимизированной версией перед отправкой в облако. Анонимизация выполняется всегда, независимо от этой галочки."
          >
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={anonymizeConfirm}
              onChange={(e) => onToggleAnonymizeConfirm?.(e.target.checked)}
            />
            Подтверждать перед отправкой
          </label>
        )}

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
          {showAuthHint && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Чтобы отправить сообщение, сначала войдите в аккаунт.
            </div>
          )}
          <DialogHeader>
            <DialogTitle>
              {authMode === 'login' ? 'Вход в аккаунт' : 'Регистрация'}
            </DialogTitle>
          </DialogHeader>
          {/* aria-busy: скринридер объявит форму занятой, пока идёт запрос. */}
          <form onSubmit={handleSubmit} className="space-y-3" aria-busy={authPending}>
            <fieldset disabled={authPending} className="space-y-3 disabled:opacity-60">
              <div className="space-y-1">
                <label className="text-xs text-neutral-600">Логин</label>
                <input
                  className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm disabled:cursor-not-allowed"
                  placeholder="Введите логин"
                  autoComplete="username"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-neutral-600">Пароль</label>
                <input
                  className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm disabled:cursor-not-allowed"
                  type="password"
                  placeholder="Введите пароль"
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </div>
            </fieldset>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={toggleAuthMode}
                disabled={authPending}
                className="text-xs text-neutral-600 hover:text-black disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-neutral-600"
              >
                {authMode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex items-center gap-2 text-sm px-4 py-2 bg-primary text-black rounded transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {authPending && (
                  // aria-hidden: текст кнопки уже меняется на «Входим…»,
                  // дублировать колесо в озвучке не нужно.
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-90"
                      fill="currentColor"
                      d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
                    />
                  </svg>
                )}
                {authPending ? pendingLabel : submitLabel}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};
