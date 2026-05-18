'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SUPPORTED_UPLOAD_FORMATS } from '@/lib/document-upload-guide';
import { LOCAL_MODEL_LABELS } from '@/lib/chat-models';

const STORAGE_KEY = 'guestWelcomeDismissed';

type GuestWelcomeGuideProps = {
  open: boolean;
  modelIds: string[];
};

export function GuestWelcomeGuide({ open, modelIds }: GuestWelcomeGuideProps) {
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    setVisible(open);
  }, [open]);

  const modelLabels = useMemo(
    () => modelIds.map((id) => LOCAL_MODEL_LABELS[id] ?? id),
    [modelIds],
  );

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  return (
    <Dialog
      open={visible}
      onOpenChange={(v) => !v && dismiss()}
      panelClassName="max-w-2xl max-h-[90vh] overflow-y-auto"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Краткая памятка</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm text-neutral-800 leading-relaxed">
          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Загрузка документов</h3>
            <p>
              Прикрепляйте расшифровки и материалы через кнопку вложений в поле ввода чата. Рекомендуемый
              суммарный объём — около <strong>50 страниц</strong> по всем
              файлам в диалоге. Небольшое превышение обычно допустимо, но при большом объёме точность ответов
              и протокола может снизиться.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Поддерживаемые форматы</h3>
            <ul className="list-disc pl-5 space-y-0.5">
              {SUPPORTED_UPLOAD_FORMATS.map((f) => (
                <li key={f.ext}>
                  <span className="font-medium">{f.ext}</span>
                  {f.note ? ` — ${f.note}` : ''}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Если модель «упала» с ошибкой</h3>
            <p>
              Обновите страницу (F5) и отправьте сообщение ещё раз. Длинные диалоги и большие вложения
              увеличивают время ответа — дождитесь завершения генерации.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Как устроен интерфейс</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Слева</strong> — история чатов (после входа список сохраняется на сервере).
              </li>
              <li>
                <strong>По центру</strong> — диалог с ассистентом; выберите модель в списке над полем ввода.
              </li>
              <li>
                <strong>Справа</strong> — панель документа (протокол): редактирование, проверка, скачивание
                DOCX/ZIP, копирование.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Ручное редактирование протокола</h3>
            <p>
              Если вы изменили текст в правой панели вручную, а затем продолжили чат, ассистент может
              опираться на <strong>последнюю версию, которую сформировал ИИ</strong>, а не на ваши правки.
              После существенных правок лучше явно попросить обновить протокол в документе.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-neutral-900 mb-1">Модели</h3>
            <p>
              Сейчас доступны {modelLabels.length > 0 ? modelLabels.join(' и ') : 'локальные модели'} — можно
              пробовать обе и сравнить качество на ваших материалах.
            </p>
          </section>
        </div>

        <div className="mt-6 flex justify-end">
          <Button type="button" onClick={dismiss}>
            Понятно
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Показывать памятку гостю, пока не нажали «Понятно». */
export function shouldShowGuestWelcome(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}
