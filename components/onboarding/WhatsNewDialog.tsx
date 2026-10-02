'use client';

import { useEffect, useState } from 'react';
import { FolderOpen, KeyRound, Shield, Sparkles } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * «Что нового» — всплывающая плашка новостей при входе (как патч-ноуты в игре).
 * Показывается один раз на версию: ключ версии в localStorage. Чтобы анонсировать
 * следующую фичу — поменяй WHATS_NEW_VERSION и содержимое.
 */
export const WHATS_NEW_VERSION = 'folders-admin-v1';
const STORAGE_KEY = `whatsNewSeen:${WHATS_NEW_VERSION}`;

type WhatsNewDialogProps = {
  open: boolean;
  onClose?: () => void;
};

export function WhatsNewDialog({ open, onClose }: WhatsNewDialogProps) {
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    setVisible(open);
  }, [open]);

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    setVisible(false);
    onClose?.();
  };

  return (
    <Dialog open={visible} onOpenChange={(v) => !v && dismiss()} panelClassName="max-w-lg w-full">
      <DialogContent>
        {/* Яркая плашка-шапка с бейджем UPDATE */}
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-sky-500 via-indigo-500 to-violet-600 px-5 py-5 text-white">
          <div className="absolute -right-6 -top-8 size-28 rounded-full bg-white/10 blur-xl" />
          <div className="absolute -bottom-10 -left-4 size-24 rounded-full bg-white/10 blur-xl" />
          <div className="relative flex items-center gap-2">
            <span className="inline-flex animate-pulse items-center gap-1 rounded-full bg-amber-400 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-black shadow">
              <Sparkles className="size-3.5" /> Update
            </span>
            <span className="text-xs font-medium text-white/80">Новое в Протоколёре</span>
          </div>
          <h2 className="relative mt-3 text-xl font-bold leading-tight">
            Папки проектов
          </h2>
          <p className="relative mt-1 text-sm text-white/85">
            Чаты по проектам, общие инструкции проекта и собственный пароль.
          </p>
        </div>

        {/* Содержимое */}
        <div className="mt-4 space-y-3 text-sm text-neutral-800">
          <div className="flex items-start gap-3">
            <FolderOpen className="mt-0.5 size-5 shrink-0 text-indigo-500" />
            <div>
              <div className="font-semibold text-neutral-900">Папки проектов</div>
              <p className="text-neutral-700">
                В боковой панели нажмите «+» у «Общих папок» и вступите в папки своих проектов. Чаты в
                папке видите только вы, а инструкции проекта протоколер учитывает в каждом её чате. Для
                себя можно завести личные папки.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold text-neutral-900">Вход и пароль</div>
              <p className="text-neutral-700">
                Учётные записи заводит администратор. При первом входе достаточно ввести логин — пароль
                вы придумаете сами. Сменить его можно кнопкой «Сменить пароль» в шапке.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Shield className="mt-0.5 size-5 shrink-0 text-emerald-600" />
            <div>
              <div className="font-semibold text-neutral-900">Данные остаются на сервере</div>
              <p className="text-neutral-700">
                Протоколы готовит только локальная модель — расшифровки никуда не отправляются.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <Button type="button" onClick={dismiss}>
            Отлично, понятно
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Показывать плашку новостей, пока пользователь не закрыл её для этой версии. */
export function shouldShowWhatsNew(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

/** Пометить новость как просмотренную (напр. когда её содержимое уже показано в памятке). */
export function markWhatsNewSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}
