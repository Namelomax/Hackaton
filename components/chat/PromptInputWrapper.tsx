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
import { ChevronDown, DatabaseIcon, Loader2Icon, Trash2 } from 'lucide-react';

export type ChatTransportBodyExtras = {
  chatProvider: 'openrouter' | 'ollama';
  chatModel: string;
  useRagContext: boolean;
  ragMode: string;
};

async function blobUrlToFile(url: string, filename: string, mediaType?: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], filename || 'upload.bin', {
    type: mediaType || blob.type || 'application/octet-stream',
  });
}

const RagIndexControl = ({
  authUser,
  status,
  onOpenAuthDialog,
  onRagIndexed,
  onNotify,
}: {
  authUser: { id: string; username: string } | null;
  status: string;
  onOpenAuthDialog?: () => void;
  onRagIndexed?: () => void;
  onNotify: (message: string | null) => void;
}) => {
  const attachments = usePromptInputAttachments();
  const [busy, setBusy] = useState(false);
  // useRef-лок проверяется СИНХРОННО до setState — иначе быстрый двойной клик и
  // React strict-mode успевают отправить два запроса до того как busy=true применится.
  const lockRef = useRef(false);
  // URL-ы (blob:), которые уже успешно проиндексированы в текущей сессии — не отправляем повторно.
  const indexedUrlsRef = useRef<Set<string>>(new Set());

  const handleClick = async () => {
    if (lockRef.current) return;
    if (!authUser?.id) {
      onOpenAuthDialog?.();
      return;
    }
    const files = attachments.files;
    if (!files.length) {
      onNotify('Сначала прикрепите файл.');
      return;
    }

    lockRef.current = true;
    setBusy(true);
    onNotify(null);
    let anyIndexed = false;
    try {
      for (const f of files) {
        const url = String((f as any).url || '');
        const name = String((f as any).filename || 'upload.bin');
        const mt = (f as any).mediaType as string | undefined;
        const id = String((f as any).id || '');
        if (!url) continue;
        if (indexedUrlsRef.current.has(url)) {
          if (id) attachments.remove(id);
          continue;
        }
        const fileObj = await blobUrlToFile(url, name, mt);
        const fd = new FormData();
        fd.append('file', fileObj);
        const res = await fetch('/api/rag/upload', { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const detail =
            typeof j?.detail === 'string'
              ? j.detail
              : Array.isArray(j?.detail)
                ? j.detail.map((x: unknown) => String(x)).join('; ')
                : j?.error || res.statusText;
          throw new Error(detail || 'RAG upload failed');
        }
        indexedUrlsRef.current.add(url);
        anyIndexed = true;
        // Убираем уже проиндексированный файл из аттачментов — это и предотвращает повтор по тому же blob,
        // и сразу показывает пользователю, что файл ушёл в индекс (а не висит как «вложение к следующему чату»).
        if (id) attachments.remove(id);
      }
      if (anyIndexed) {
        onRagIndexed?.();
        onNotify('Файлы проиндексированы в RAG. Можно включить «контекст из RAG» и задать вопрос.');
      } else {
        onNotify('Все выбранные файлы уже в индексе.');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Ошибка индексации RAG');
    } finally {
      setBusy(false);
      lockRef.current = false;
    }
  };

  return (
    <button
      type="button"
      disabled={busy || status === 'submitted' || status === 'streaming'}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-700 shadow-xs hover:bg-neutral-50 disabled:pointer-events-none disabled:opacity-40"
      title="Отправить вложения в RAG (индексация)"
      onClick={(e) => {
        e.preventDefault();
        void handleClick();
      }}
    >
      {busy ? <Loader2Icon className="size-4 animate-spin" /> : <DatabaseIcon className="size-4" />}
    </button>
  );
};

type RagIndexedDoc = { id: string; filename: string; status?: string };

const RagDocumentsPanel = ({
  refreshNonce,
  onNotify,
}: {
  refreshNonce: number;
  onNotify: (message: string | null) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<RagIndexedDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    onNotify(null);
    try {
      const res = await fetch('/api/rag/documents');
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        const detail =
          typeof j?.detail === 'string'
            ? j.detail
            : typeof j?.error === 'string'
              ? j.error
              : 'Не удалось загрузить список индекса RAG';
        onNotify(detail);
        setDocs([]);
        return;
      }
      setDocs(Array.isArray(j) ? (j as RagIndexedDoc[]) : []);
    } catch {
      onNotify('Ошибка сети при загрузке списка RAG');
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    if (open) void load();
  }, [open, refreshNonce, load]);

  const removeDoc = async (id: string) => {
    if (!id || deletingId) return;
    setDeletingId(id);
    onNotify(null);
    try {
      const res = await fetch('/api/rag/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        onNotify(
          typeof j?.detail === 'string'
            ? j.detail
            : typeof j?.error === 'string'
              ? j.error
              : 'Не удалось удалить документ',
        );
        return;
      }
      await load();
      onNotify('Документ удалён из индекса.');
    } catch {
      onNotify('Ошибка при удалении из индекса');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50/90 text-xs text-neutral-800">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-neutral-100/80"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-medium">Документы в индексе RAG</span>
        <ChevronDown className={`size-4 shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-neutral-200 px-2 py-2 max-h-52 overflow-y-auto space-y-1.5">
          {loading ? (
            <div className="flex items-center gap-2 text-neutral-600 py-1">
              <Loader2Icon className="size-3.5 animate-spin" />
              Загрузка…
            </div>
          ) : docs.length === 0 ? (
            <p className="text-neutral-600 py-0.5">В индексе пока нет документов (или сервис RAG недоступен).</p>
          ) : (
            docs.map((d) => (
              <div
                key={d.id}
                className="flex items-start justify-between gap-2 rounded border border-neutral-100 bg-white px-2 py-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={d.filename}>
                    {d.filename}
                  </div>
                  {d.status ? (
                    <div className="text-[10px] text-neutral-500 truncate">{d.status}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  title="Удалить из индекса"
                  disabled={deletingId === d.id}
                  className="shrink-0 rounded p-1 text-red-700 hover:bg-red-50 disabled:opacity-40"
                  onClick={() => void removeDoc(d.id)}
                >
                  {deletingId === d.id ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
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
  const canSend = status === 'ready' && (input.trim().length > 0 || attachments.files.length > 0);
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
        title: `Conversation ${new Date().toLocaleString()}`,
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
  onRagIndexed?: () => void;
};

export const PromptInputWrapper = ({
  input,
  setInput,
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
  onRagIndexed,
}: PromptInputWrapperProps) => {
  const submitLockRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authWarningOpen, setAuthWarningOpen] = useState(false);
  const [ragNotice, setRagNotice] = useState<string | null>(null);
  const [ragDocsNonce, setRagDocsNonce] = useState(0);
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

  useEffect(() => {
    if (!ragNotice) return;
    const t = setTimeout(() => setRagNotice(null), 6000);
    return () => clearTimeout(t);
  }, [ragNotice]);

  const handleSubmit = async (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    // Проверяем статус - разрешаем отправку только в 'ready'
    // После ошибки useChat должен вернуть статус в 'ready'
    if (status !== 'ready') return;
    
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

      const hasPayload = Boolean(trimmedText) || preparedFiles.length > 0;
      if (!hasPayload) return;

      // Avoid blocking UI on client-side extraction; server performs extraction/injection.
      void preparedFiles.map((f) => (f?.mediaType ? isTextExtractable(f.mediaType) : false));

      const baseConversationId = prepareSend ? (await prepareSend()) ?? null : conversationId;
      if (baseConversationId === null) return;

      const clientMessageId =
        (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
          ? (crypto as any).randomUUID()
          : String(Date.now());

      if (onUserMessageQueued) {
        const parts: any[] = [];
        if (trimmedText) parts.push({ type: 'text', text: trimmedText });
        for (const f of preparedFiles) {
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

      const ensuredConversationId = await ensureConversationCreated(
        authUser,
        baseConversationId,
        setConversationsList,
        setConversationId,
        abort.signal
      );

      if (cancelRequestedRef.current || abort.signal.aborted) return;

      sendMessage(
        {
          id: clientMessageId,
          text: trimmedText,
          files: preparedFiles,
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
      {/* Attachments*/}
      <AttachmentsSection />
      {ragNotice && <div className="text-xs text-neutral-600 px-0.5">{ragNotice}</div>}
      <RagDocumentsPanel refreshNonce={ragDocsNonce} onNotify={setRagNotice} />

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

          <RagIndexControl
            authUser={authUser}
            status={status}
            onOpenAuthDialog={onOpenAuthDialog}
            onRagIndexed={() => {
              onRagIndexed?.();
              setRagDocsNonce((n) => n + 1);
            }}
            onNotify={setRagNotice}
          />

          <SubmitButton status={status} input={input} isLocked={isSubmitting} onStop={handleStop} />
        </div>
      </div>

    </PromptInput>
  </div>
);

};
