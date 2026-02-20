'use client';

import { Dispatch, SetStateAction, FormEvent, useCallback, useRef, useState } from 'react';
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
}: PromptInputWrapperProps) => {
  const submitLockRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [authWarningOpen, setAuthWarningOpen] = useState(false);
  const cancelRequestedRef = useRef(false);
  const preSendAbortRef = useRef<AbortController | null>(null);
  const authWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    submitLockRef.current = false;
    setIsSubmitting(false);
  }, [stop]);

  const handleSubmit = async (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

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
          },
        }
      );

      setInput('');
    } finally {
      preSendAbortRef.current = null;
      setIsSubmitting(false);
      submitLockRef.current = false;
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
