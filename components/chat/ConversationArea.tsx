'use client';

import { useMemo } from 'react';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import { MessageRenderer } from '@/components/chat/MessageRenderer';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { useEffect } from 'react';

const AutoScrollOnUpdates = ({ deps }: { deps: unknown }) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  useEffect(() => {
    // Прокручивать вниз ТОЛЬКО если пользователь уже находится внизу
    // Это позволяет видеть контент в центре экрана во время генерации
    if (!isAtBottom) return;

    const raf = requestAnimationFrame(() => {
      scrollToBottom({ animation: 'instant' });
    });

    return () => cancelAnimationFrame(raf);
  }, [deps, isAtBottom, scrollToBottom]);

  return null;
};

type ConversationAreaProps = {
  chatKey: string;
  messages: any[];
  status: string;
  copiedId: string | null;
  onRegenerate: (id: string) => void;
  onCopy: (text: string, id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
};

export const ConversationArea = ({
  chatKey,
  messages,
  status,
  copiedId,
  onRegenerate,
  onCopy,
  onEdit,
}: ConversationAreaProps) => {
  const normalizedMessages = useMemo(() => {
    const list = Array.isArray(messages) ? messages : [];
    const seen = new Set<string>();
    const result: any[] = [];
    list.forEach((msg, index) => {
      const rawId = msg?.id ? String(msg.id) : '';
      const fallbackId = `temp-${index}-${msg?.role || 'user'}`;
      const id = rawId || fallbackId;
      if (seen.has(id)) return;
      seen.add(id);
      result.push(rawId ? msg : { ...msg, id });
    }
    );
    return result;
  }, [messages]);

  const lastMessageId = normalizedMessages.at(-1)?.id;

  return (
    <Conversation key={chatKey}>
      <ConversationContent>
        {normalizedMessages.map((message, index) => (
          <MessageRenderer
            key={message.id || `msg-${index}`}
            message={message}
            isLastMessage={message.id === lastMessageId}
            status={status}
            copiedId={copiedId}
            onRegenerate={onRegenerate}
            onCopy={onCopy}
            onEdit={onEdit}
          />
        ))}

        {status === 'submitted' && <Loader />}

        <AutoScrollOnUpdates deps={messages} />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
};
