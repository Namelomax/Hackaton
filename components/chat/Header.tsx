'use client';

import { Dispatch, FormEvent, SetStateAction, useEffect, useState } from 'react';
import { ChangePasswordDialog } from '@/components/auth/ChangePasswordDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type AuthUser = { id: string; username: string; role?: 'admin' | 'user' } | null;

/**
 * login — обычный вход; register — первый вход админа из ADMIN_USERNAMES;
 * setup — приглашённый пользователь придумывает пароль при первом входе.
 */
export type AuthMode = 'login' | 'register' | 'setup';

const MIN_PASSWORD = 8;

type HeaderProps = {
  authUser: AuthUser;
  authUsername: string;
  authPassword: string;
  authMode: AuthMode;
  authOpen: boolean;
  setAuthOpen: (open: boolean) => void;
  onAuth: () => void;
  /** Запрос входа/регистрации в полёте — блокируем форму и показываем прогресс. */
  authPending?: boolean;
  onLogout: () => void;
  setAuthUsername: Dispatch<SetStateAction<string>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setAuthMode: Dispatch<SetStateAction<AuthMode>>;
  toggleAuthMode: () => void;
  brandLabel?: string;
  showAuthHint?: boolean;
  anonymizeMode?: boolean;
  /** false — закрытый контур (CLOUD_MODE=off): переключателя облака нет. */
  cloudModeAvailable?: boolean;
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
  cloudModeAvailable = true,
  onToggleAnonymize,
  anonymizeConfirm = true,
  onToggleAnonymizeConfirm,
}: HeaderProps) => {
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Повтор пароля нужен только при придумывании — живёт здесь, а не в page.
  const [passwordRepeat, setPasswordRepeat] = useState('');
  useEffect(() => {
    setPasswordRepeat('');
  }, [authMode]);

  useEffect(() => {
    if (authUser) {
      setAuthOpen(false);
    }
  }, [authUser, setAuthOpen]);

  const openAuthModal = (mode: AuthMode) => {
    setAuthMode(mode);
    setAuthOpen(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (authPending) return;
    onAuth();
  };

  const hasUsername = authUsername.trim().length > 0;
  const setupProblem =
    authMode !== 'setup'
      ? null
      : authPassword.length > 0 && authPassword.length < MIN_PASSWORD
        ? `Не короче ${MIN_PASSWORD} символов`
        : passwordRepeat.length > 0 && passwordRepeat !== authPassword
          ? 'Пароли не совпадают'
          : null;
  // При входе пароль можно не вводить: так приглашённый пользователь узнаёт,
  // что ему пора придумать пароль.
  const canSubmit =
    !authPending &&
    hasUsername &&
    (authMode === 'login' ||
      (authMode === 'register' && authPassword.length > 0) ||
      (authMode === 'setup' && authPassword.length >= MIN_PASSWORD && authPassword === passwordRepeat));
  const submitLabel =
    authMode === 'login' ? 'Войти' : authMode === 'setup' ? 'Сохранить и войти' : 'Создать администратора';
  const pendingLabel = authMode === 'login' ? 'Входим…' : authMode === 'setup' ? 'Сохраняем…' : 'Создаём…';

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
        {!cloudModeAvailable && (
          <div
            className="rounded-lg border bg-background px-3 py-1.5 text-xs text-muted-foreground"
            title="Облачный режим отключён на этом сервере: все данные обрабатываются локальной моделью внутри контура."
          >
            🖥️ Локальная LLM
          </div>
        )}
        {cloudModeAvailable && (
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
        )}

        {/* Подтверждение анонимизации: скрывает окно предпросмотра. Сама
            анонимизация выполняется всегда — этот флаг на неё не влияет. */}
        {cloudModeAvailable && anonymizeMode && (
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
              {authUser.role === 'admin' && (
                <a href="/admin" className="text-sm px-3 py-1 border rounded hover:bg-muted/30">
                  Администрирование
                </a>
              )}
              <button
                type="button"
                onClick={() => setPasswordOpen(true)}
                className="text-sm px-3 py-1 border rounded hover:bg-muted/30"
              >
                Сменить пароль
              </button>
              <button onClick={onLogout} className="text-sm px-3 py-1 bg-primary text-primary-foreground rounded">
                Выйти
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {/* Открытой регистрации нет: учётные записи выдаёт администратор. */}
              <button
                onClick={() => openAuthModal('login')}
                className="text-sm px-3 py-1 bg-primary text-black rounded"
              >
                Войти
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
              {authMode === 'login'
                ? 'Вход в аккаунт'
                : authMode === 'setup'
                  ? 'Придумайте пароль'
                  : 'Первый вход администратора'}
            </DialogTitle>
          </DialogHeader>
          <p className="mb-3 text-xs text-neutral-600">
            {authMode === 'login'
              ? 'Учётную запись заводит администратор. Входите впервые — введите только логин и нажмите «Войти»: система предложит придумать пароль.'
              : authMode === 'setup'
                ? `Для логина «${authUsername}» пароль ещё не задан. Придумайте его — дальше входите с ним. Не короче ${MIN_PASSWORD} символов.`
                : 'Только для логинов из ADMIN_USERNAMES в настройках сервера, которые ещё не заведены. Остальным учётные записи создаёт администратор.'}
          </p>
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
                  readOnly={authMode === 'setup'}
                  onChange={(e) => setAuthUsername(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-neutral-600">
                  {authMode === 'setup' ? 'Новый пароль' : 'Пароль'}
                </label>
                <input
                  className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm disabled:cursor-not-allowed"
                  type="password"
                  placeholder={
                    authMode === 'login'
                      ? 'Введите пароль (при первом входе — пусто)'
                      : authMode === 'setup'
                        ? 'Придумайте пароль'
                        : 'Введите пароль'
                  }
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </div>
              {authMode === 'setup' && (
                <div className="space-y-1">
                  <label className="text-xs text-neutral-600">Повторите пароль</label>
                  <input
                    className="w-full border border-neutral-300 bg-white text-black px-3 py-2 rounded text-sm disabled:cursor-not-allowed"
                    type="password"
                    placeholder="Ещё раз"
                    autoComplete="new-password"
                    value={passwordRepeat}
                    onChange={(e) => setPasswordRepeat(e.target.value)}
                  />
                </div>
              )}
              {setupProblem && <p className="text-xs text-red-700">{setupProblem}</p>}
            </fieldset>
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={toggleAuthMode}
                disabled={authPending}
                className="text-xs text-neutral-600 hover:text-black disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-neutral-600"
              >
                {authMode === 'login'
                  ? 'Первый вход администратора'
                  : authMode === 'setup'
                    ? 'Назад ко входу'
                    : 'Обычный вход'}
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

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
};
