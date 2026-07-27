'use client';

import { Dispatch, SetStateAction, FormEvent, useCallback, useRef, useState, useEffect } from 'react';
import { FileUIPart } from 'ai';
import {
  PromptInput,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputActionAddAttachments,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputMessage,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { isTextExtractable } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
export type ChatTransportBodyExtras = {
  chatProvider: 'openrouter' | 'ollama';
  chatModel: string;
  useRagContext: boolean;
  ragMode: string;
  useThinking?: boolean;
  anonymize?: boolean;
};

const AttachmentsSection = () => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <PromptInputAttachments>
      {(attachment) => <PromptInputAttachment data={attachment} />}
    </PromptInputAttachments>
  );
};

const SubmitButton = ({
  status,
  input,
  isLocked,
  onStop,
}: {
  status: string;
  input: string;
  isLocked: boolean;
  onStop?: () => void;
}) => {
  const attachments = usePromptInputAttachments();
  const canSend = (status === 'ready' || status === 'error') && (input.trim().length > 0 || attachments.files.length > 0);
  const isStoppable = isLocked || status === 'submitted' || status === 'streaming';

  return (
    <PromptInputSubmit
      // Use "streaming" icon (stop-square) whenever user can cancel.
      status={isStoppable ? 'streaming' : 'ready'}
      disabled={!isStoppable && !canSend}
      onClick={(e) => {
        if (isStoppable && onStop) {
          e.preventDefault();
          onStop();
        }
      }}
    />
  );
};

const ensureConversationCreated = async (
  authUser: { id: string; username: string } | null,
  conversationId: string | null,
  setConversationsList: Dispatch<SetStateAction<any[]>>,
  setConversationId: Dispatch<SetStateAction<string | null>>,
  signal?: AbortSignal
) => {
  if (!authUser || (conversationId && !String(conversationId).startsWith('local-'))) {
    return conversationId;
  }

  try {
    const resp = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        userId: authUser.id,
        title: 'Чат',
      }),
    });

    const json = await resp.json();
    if (json?.success && json.conversation) {
      setConversationsList((prev) => {
        const withoutLocal = prev.filter((conv) => !String(conv.id).startsWith('local-'));
        return [json.conversation, ...withoutLocal];
      });
      setConversationId(json.conversation.id);
      localStorage.setItem('activeConversationId', json.conversation.id);
      return json.conversation.id;
    }
  } catch (error) {
    console.error('Failed to create conversation before sending message', error);
  }

  return conversationId;
};

type PromptInputWrapperProps = {
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  quoteText?: string;
  setQuoteText?: (text: string) => void;
  status: string;
  authUser: { id: string; username: string } | null;
  conversationId: string | null;
  setConversationId: Dispatch<SetStateAction<string | null>>;
  setConversationsList: Dispatch<SetStateAction<any[]>>;
  setMessages: (messages: any[]) => void;
  sendMessage: (payload: any, options?: any) => void;
  stop: () => void;
  className?: string;
  selectedPromptId?: string | null;
  documentContent?: string;
  prepareSend?: () => Promise<string | null | undefined> | string | null | undefined;
  onUserMessageQueued?: (message: any) => void;
  onOpenAuthDialog?: () => void;
  chatBody?: ChatTransportBodyExtras;
  anonymizeMode?: boolean;
  /** Показывать диалог подтверждения перед отправкой в облако. Анонимизация
   * происходит ВСЕГДА (на сервере) независимо от этого флага; выключение
   * убирает только окно предпросмотра. По умолчанию включено. */
  anonymizeConfirm?: boolean;
  onAnonymizationReady?: (data: {
    anonymizedText: string;
    mapping: Record<string, string>;
    /** Диалог, к которому относится артефакт (id уже СЕРВЕРНЫЙ после ensureConversationCreated). */
    conversationId?: string | null;
  }) => void;
};

export const PromptInputWrapper = ({
  input,
  setInput,
  quoteText,
  setQuoteText,
  status,
  authUser,
  conversationId,
  setConversationId,
  setConversationsList,
  setMessages,
  sendMessage,
  stop,
  className,
  selectedPromptId,
  documentContent,
  prepareSend,
  onUserMessageQueued,
  onOpenAuthDialog,
  chatBody,
  anonymizeMode = false,
  anonymizeConfirm = true,
  onAnonymizationReady,
}: PromptInputWrapperProps) => {
  const submitLockRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authWarningOpen, setAuthWarningOpen] = useState(false);

  // ── Preview анонимизации документа перед отправкой в облако ──
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [previewSummary, setPreviewSummary] = useState<Record<string, number>>({});
  const [previewMapping, setPreviewMapping] = useState<Record<string, string>>({});
  const previewResolverRef = useRef<((decision: 'confirm' | 'cancel') => void) | null>(null);

  const resolvePreview = useCallback((decision: 'confirm' | 'cancel') => {
    setPreviewOpen(false);
    const resolve = previewResolverRef.current;
    previewResolverRef.current = null;
    resolve?.(decision);
  }, []);

  /**
   * Прогоняет вложения через /api/anonymize, показывает preview и ждёт решения.
   * Возвращает: 'confirm' — отправлять в облако; 'cancel' — отменить;
   * 'fallback' — анонимизатор недоступен/ошибка, отправляем как есть (сервер
   * сам уведомит и уйдёт на локальную модель).
   */
  const requestAnonymizationPreview = useCallback(
    async (
      files: FileUIPart[],
      text: string,
      convId: string | null,
      signal?: AbortSignal,
    ): Promise<'confirm' | 'cancel' | 'fallback'> => {
      setPreviewLoading(true);
      setPreviewText('');
      setPreviewSummary({});
      setPreviewMapping({});
      setPreviewOpen(true);
      try {
        const payloadFiles = files.map((f: any) => ({
          url: f?.url || f?.data,
          mediaType: f?.mediaType || f?.mimeType,
          filename: f?.filename || f?.name,
        }));
        // Сетевой обрыв (например, браузер приостановил фоновую вкладку и убил
        // соединение) — не повод отключать анонимизацию: повторяем запрос.
        // Повторный вызов дёшев для уже известных значений (mapping-кеш диалога).
        const MAX_ATTEMPTS = 3;
        let res: Response | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            res = await fetch('/api/anonymize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal,
              body: JSON.stringify({
                conversationId: convId,
                files: payloadFiles,
                ...(text && text.trim() ? { text: text.trim() } : {}),
              }),
            });
            break;
          } catch (fetchErr) {
            if ((fetchErr as any)?.name === 'AbortError' || signal?.aborted) throw fetchErr;
            if (attempt === MAX_ATTEMPTS) throw fetchErr;
            console.warn(
              `[anonymize-preview] попытка ${attempt} оборвалась (${String(fetchErr)}), повторяю…`,
            );
            await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
        if (!res) throw new Error('нет ответа от /api/anonymize');
        if (res.status === 503) {
          setPreviewOpen(false);
          // Сервер различает «не отвечает» и «не успел за бюджет»: во втором
          // случае анонимизатор жив, и писать «недоступен» — обманывать.
          let info: any = null;
          try {
            info = JSON.parse(await res.clone().text());
          } catch {}
          if (info?.timeout) {
            toast.warning('Анонимизация не успела', {
              description: `Обработка заняла больше ${info.elapsedSec ?? '—'} с. Отправляю через локальную модель (данные не уходят в облако).`,
            });
          } else {
            toast.warning('Анонимизатор недоступен', {
              description: 'Документ будет обработан локальной моделью (данные не уходят в облако).',
            });
          }
          return 'fallback';
        }
        // Тело может оказаться НЕ JSON: при таймауте функции Vercel отдаёт
        // текст «An error occurred…», и res.json() ронял SyntaxError, который
        // пользователь видел сырым («Unexpected token 'A'»).
        const rawBody = await res.text();
        let json: any = null;
        try {
          json = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          setPreviewOpen(false);
          toast.error('Анонимизатор не ответил', {
            description:
              `Сервис вернул не JSON (код ${res.status}) — вероятно, таймаут. ` +
              'Отправляю через локальную модель.',
          });
          return 'fallback';
        }
        if (!res.ok || !json?.ok) {
          setPreviewOpen(false);
          toast.error('Не удалось анонимизировать документ', {
            description: json?.error || 'Отправляю через локальную модель.',
          });
          return 'fallback';
        }
        setPreviewText(String(json.anonymizedText || ''));
        setPreviewSummary(json.summary || {});
        setPreviewMapping((json.mapping && typeof json.mapping === 'object') ? json.mapping : {});
        setPreviewLoading(false);
        onAnonymizationReady?.({
          anonymizedText: String(json.anonymizedText || ''),
          mapping: (json.mapping && typeof json.mapping === 'object') ? json.mapping : {},
          // Передаём id явно: state conversationId в page.tsx в этот момент ещё
          // старый (local-...), и артефакт терялся — панель искала его по новому id.
          conversationId: convId,
        });
        return await new Promise<'confirm' | 'cancel'>((resolve) => {
          previewResolverRef.current = resolve;
        });
      } catch (err) {
        setPreviewOpen(false);
        if ((err as any)?.name === 'AbortError') return 'cancel';
        toast.error('Ошибка анонимизации', { description: String(err) });
        return 'fallback';
      } finally {
        setPreviewLoading(false);
      }
    },
    [onAnonymizationReady],
  );
  const cancelRequestedRef = useRef(false);
  const preSendAbortRef = useRef<AbortController | null>(null);
  const authWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastErrorTimeRef = useRef<number>(0);

  const handleStop = useCallback(() => {
    cancelRequestedRef.current = true;
    try {
      preSendAbortRef.current?.abort();
    } catch {}
    preSendAbortRef.current = null;

    // Also attempt to stop any in-flight AI stream.
    try {
      stop();
    } catch {}

    // Сбрасываем блокировку немедленно - позволяем пользователю продолжить работу
    submitLockRef.current = false;
    setIsSubmitting(false);
    lastErrorTimeRef.current = Date.now();
  }, [stop]);

  // Эффект для сброса блокировки при изменении статуса на 'ready' после ошибки
  useEffect(() => {
    if (status === 'ready' && isSubmitting) {
      // Статус вернулся в 'ready', но блокировка осталась - сбрасываем
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [status, isSubmitting]);

  const handleSubmit = async (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    // Разрешаем отправку в 'ready' и 'error' — после ошибки SDK сам сбросит состояние при новом sendMessage
    if (status !== 'ready' && status !== 'error') return;
    
    if (!authUser?.id) {
      setAuthWarningOpen(true);
      if (authWarningTimeoutRef.current) {
        clearTimeout(authWarningTimeoutRef.current);
      }
      authWarningTimeoutRef.current = setTimeout(() => {
        setAuthWarningOpen(false);
      }, 2500);
      onOpenAuthDialog?.();
      return;
    }
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSubmitting(true);
    cancelRequestedRef.current = false;

    const abort = new AbortController();
    preSendAbortRef.current = abort;

    try {
      const preparedFiles: FileUIPart[] = Array.isArray(message.files)
        ? (message.files as FileUIPart[])
        : [];
      const trimmedText = (message.text || '').trim();
      const textWithQuote = quoteText
        ? `[Цитата из протокола]: «${quoteText}»\n\n${trimmedText}`
        : trimmedText;

      const hasPayload = Boolean(textWithQuote) || preparedFiles.length > 0;
      if (!hasPayload) return;

      // Сначала фиксируем id диалога (в т.ч. local- → серверный), чтобы индекс RAG совпадал с /query.
      const baseConversationId = prepareSend ? (await prepareSend()) ?? null : conversationId;
      if (baseConversationId === null) return;

      const ensuredConversationId = await ensureConversationCreated(
        authUser,
        baseConversationId,
        setConversationsList,
        setConversationId,
        abort.signal
      );

      if (cancelRequestedRef.current || abort.signal.aborted) return;

      // Все файлы отправляются как прямые вложения. RAG-индексация только по явной кнопке.
      const finalFiles = preparedFiles;

      // Avoid blocking UI on client-side extraction; server performs extraction/injection.
      void finalFiles.map((f) => (f?.mediaType ? isTextExtractable(f.mediaType) : false));

      // Режим «Облако + анонимизация»: перед отправкой в облако показываем preview
      // анонимизированной версии и ждём подтверждения — как для документа, так и
      // для обычного текстового сообщения (152-ФЗ: в облако уходит только текст
      // без ПДн). Само окно можно отключить (anonymizeConfirm=false) — тогда
      // отправляем без предпросмотра, но анонимизация всё равно выполняется на
      // сервере в /api/chat (гарантия защиты ПДн не зависит от этого флага).
      if (anonymizeMode && anonymizeConfirm && (finalFiles.length > 0 || Boolean(textWithQuote))) {
        const decision = await requestAnonymizationPreview(
          finalFiles,
          textWithQuote,
          ensuredConversationId ?? null,
          abort.signal,
        );
        if (decision === 'cancel') {
          submitLockRef.current = false;
          setIsSubmitting(false);
          return;
        }
        if (cancelRequestedRef.current || abort.signal.aborted) return;
      }

      const clientMessageId =
        (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
          ? (crypto as any).randomUUID()
          : String(Date.now());

      if (onUserMessageQueued) {
        const parts: any[] = [];
        if (trimmedText) parts.push({ type: 'text', text: trimmedText });
        for (const f of finalFiles) {
          parts.push({
            type: 'file',
            id: (f as any)?.id,
            filename: (f as any)?.filename,
            url: (f as any)?.url,
            mediaType: (f as any)?.mediaType,
          });
        }
        onUserMessageQueued({
          id: clientMessageId,
          role: 'user',
          parts,
          metadata: {},
        });
      }

      if (cancelRequestedRef.current || abort.signal.aborted) return;

      sendMessage(
        {
          id: clientMessageId,
          text: textWithQuote,
          files: finalFiles,
        } as any,
        {
          body: {
            selectedPromptId,
            documentContent: documentContent || undefined,
            ...(ensuredConversationId ? { conversationId: ensuredConversationId } : {}),
            ...(chatBody ?? {}),
          },
        }
      );

      setInput('');
      setQuoteText?.('');
    } finally {
      preSendAbortRef.current = null;
      setIsSubmitting(false);
      submitLockRef.current = false;
      // Сбрасываем время ошибки при успешной отправке
      lastErrorTimeRef.current = 0;
    }
  };

return (
  <div className={className ? `relative ${className}` : 'relative'}>
    {/* Preview анонимизации документа перед отправкой в облако */}
    {/* dismissible={false}: случайный клик мимо панели или Escape не отменяет
        долгую анонимизацию — закрыть можно только кнопками «Отмена»/«Подтвердить». */}
    <Dialog open={previewOpen} onOpenChange={(o) => { if (!o) resolvePreview('cancel'); }} panelClassName="max-w-4xl w-full" dismissible={false}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Проверка перед отправкой в облако</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground mb-2">
          В облачную модель уйдёт только этот анонимизированный текст — без персональных данных (152-ФЗ).
          Вы продолжите видеть реальные данные; обратная подстановка происходит автоматически.
        </div>
        {Object.keys(previewSummary).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Object.entries(previewSummary).map(([label, count]) => (
              <span
                key={label}
                className="rounded-full border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {label}: {count}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-3 md:flex-row">
          {/* Слева — анонимизированный текст, который уйдёт в облако */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Уйдёт в облако (без ПДн)
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-md border bg-muted/30 p-3">
              {previewLoading ? (
                <div className="text-sm text-muted-foreground">
                  Анонимизация… (короткое сообщение — быстро; для больших расшифровок от 30 секунд до пары минут — можно переключиться на другую вкладку, процесс продолжится)
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{previewText}</pre>
              )}
            </div>
          </div>
          {/* Справа — mapping: как анонимизировано (placeholder → оригинал) */}
          {!previewLoading && Object.keys(previewMapping).length > 0 && (
            <div className="flex w-full flex-col md:w-[44%]">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Mapping — что скрыто ({Object.keys(previewMapping).length})
              </div>
              <div className="max-h-[45vh] overflow-auto rounded-md border">
                <table className="w-full border-collapse text-xs">
                  <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Плейсхолдер</th>
                      <th className="px-2 py-1.5 font-medium">Оригинал (ПДн)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(previewMapping)
                      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
                      .map(([placeholder, original]) => (
                        <tr key={placeholder} className="border-t hover:bg-muted/30">
                          <td className="whitespace-nowrap px-2 py-1 align-top">
                            <code className="rounded bg-[color:var(--chart-1)]/10 px-1 py-0.5 font-mono text-[color:var(--chart-1)]">
                              {placeholder}
                            </code>
                          </td>
                          <td className="px-2 py-1 align-top break-words">{String(original)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <button
            type="button"
            onClick={() => resolvePreview('cancel')}
            className="px-3 py-1.5 text-sm rounded border hover:bg-muted"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={previewLoading}
            onClick={() => resolvePreview('confirm')}
            className="px-4 py-1.5 text-sm rounded bg-primary text-black disabled:opacity-50"
          >
            Подтвердить и отправить
          </button>
        </div>
      </DialogContent>
    </Dialog>

    {authWarningOpen && (
      <div className="pointer-events-none absolute -top-10 left-0 right-0 z-10 flex justify-center">
        <div className="rounded-md border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-700 shadow-sm">
          Чтобы отправить сообщение, сначала войдите в аккаунт.
        </div>
      </div>
    )}
    <PromptInput
      onSubmit={handleSubmit}
      className="border rounded-lg shadow-sm p-3 flex flex-col gap-2"
      multiple
      globalDrop
    >
      {/* Quote attachment */}
      {quoteText && (
        <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold text-primary mb-0.5 uppercase tracking-wide">Цитата из протокола</div>
            <span className="line-clamp-2 italic">«{quoteText}»</span>
          </div>
          <button
            type="button"
            className="ml-1 shrink-0 text-muted-foreground hover:text-foreground leading-none"
            onClick={() => setQuoteText?.('')}
          >
            ×
          </button>
        </div>
      )}

      {/* Attachments*/}
      <AttachmentsSection />

      {/* Input Area*/}
      <div className="flex items-end relative">
        <PromptInputTextarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Напишите сообщение или прикрепите файл..."
          className="min-h-[40px] resize-none w-full pr-20"
        />

        {/* Actions*/}
        <div className="absolute right-0 bottom-1 flex items-center gap-2">
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>

          <SubmitButton status={status} input={input} isLocked={isSubmitting} onStop={handleStop} />
        </div>
      </div>

    </PromptInput>
  </div>
);

};
