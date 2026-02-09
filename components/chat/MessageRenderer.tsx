'use client';

import { useState } from 'react';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Response } from '@/components/ai-elements/response';
import { Actions, Action } from '@/components/ai-elements/actions';
import { RefreshCcw, Copy, Check, Wrench, Paperclip, FileText, Image as ImageIcon, Pencil, X, Send } from 'lucide-react';

const ToolsDisplay = ({ tools, isStreaming }: { tools: any[]; isStreaming: boolean }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (tools.length === 0) return null;

  return (
    <div className="w-full my-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <Wrench className="size-4" />
        <span>Использование инструментов ({tools.length})</span>
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
        {isStreaming && (
          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700">
            В процессе...
          </span>
        )}
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2 pl-6 border-l-2 border-border">
          <div className="bg-muted/50 rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">
              Используются специальные агенты для обработки запроса
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

type MessageRendererProps = {
  message: any;
  isLastMessage: boolean;
  status: string;
  copiedId: string | null;
  onRegenerate: (id: string) => void;
  onCopy: (text: string, id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
};

const sanitizeUserText = (text: string) => {
  const hiddenPattern = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;
  const hadHidden = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/i.test(text);
  const visible = text.replace(hiddenPattern, '').trim();
  return { visible, hadHidden };
};


const renderTextResponse = (rawText: string, key: string) => {
  const { visible, hadHidden } = sanitizeUserText(rawText);

  if (visible) {
    return <Response key={key}>{visible}</Response>;
  }

  if (hadHidden) {
    return (
      <Response key={key} className="text-muted-foreground text-sm italic">
        Текст, извлечённый из вложения, скрыт и отправлен модели.
      </Response>
    );
  }

  return <Response key={key}>{rawText}</Response>;
};

type Attachment = {
  id?: string;
  name?: string;
  url?: string;
  mediaType?: string;
};

const renderAttachment = (att: Attachment, index: number) => {
  const isImage = att.mediaType?.startsWith('image/') && att.url;
  const fallbackName = att.name || 'attachment';
  return (
    <div
      key={att.id || index}
      className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2"
    >
      <div className="flex size-12 items-center justify-center overflow-hidden rounded-md border bg-background">
        {isImage ? (
          <img
            src={att.url}
            alt={fallbackName}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex items-center gap-1 text-muted-foreground text-xs">
            <Paperclip className="size-4" />
            <FileText className="size-4" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{fallbackName}</div>
        <div className="text-xs text-muted-foreground truncate">{att.mediaType || 'file'}</div>
      </div>
      {att.url && !att.url.startsWith('data:') && (
        <a
          className="text-xs text-blue-600 hover:underline"
          href={att.url}
          target="_blank"
          rel="noreferrer"
        >
          Открыть
        </a>
      )}
    </div>
  );
};

const getReasoningDurationSeconds = (part: any): number | undefined => {
  const metadata = part?.metadata ?? {};
  const directSeconds = [
    metadata.durationSeconds,
    metadata.duration,
    metadata.thinkingDurationSeconds,
    metadata.thinking_duration_seconds,
    metadata.reasoningDurationSeconds,
  ].find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
  if (typeof directSeconds === 'number') {
    return Math.round(directSeconds);
  }

  const durationMs = [
    metadata.durationMs,
    metadata.thinkingDurationMs,
    metadata.thinking_duration_ms,
    metadata.reasoningDurationMs,
    metadata.latencyMs,
    metadata?.thinking?.durationMs,
  ].find((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);

  if (typeof durationMs === 'number') {
    return Math.max(1, Math.round(durationMs / 1000));
  }

  return undefined;
};

const persistReasoningDuration = (part: any, durationSeconds: number) => {
  if (!part || !Number.isFinite(durationSeconds)) return;
  const normalized = Math.max(1, Math.round(durationSeconds));
  part.metadata = {
    ...(part.metadata ?? {}),
    durationSeconds: normalized,
  };
};

export const MessageRenderer = ({
  message,
  isLastMessage,
  status,
  copiedId,
  onRegenerate,
  onCopy,
  onEdit,
}: MessageRendererProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const attachments: Attachment[] = Array.isArray(message?.metadata?.attachments)
    ? message.metadata.attachments
    : Array.isArray(message?.parts)
      ? message.parts
          .filter((p: any) => p?.type === 'file')
          .map((p: any) => ({
            id: p.id,
            name: p.filename,
            url: p.url,
            mediaType: p.mediaType,
          }))
      : [];

  const textParts = message.parts.filter(
    (part: any): part is { type: 'text'; text: string } => part.type === 'text'
  );
  const reasoningParts = message.parts.filter((part: any) => part.type === 'reasoning');
  const toolParts = message.parts.filter(
    (part: any) => part.type.startsWith('tool-') && !part.type.startsWith('tool-data')
  );

  const isToolsStreaming = status === 'streaming' && isLastMessage && toolParts.length > 0;

  return (
    <Message from={message.role}>
      <MessageContent>
        {attachments.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              <ImageIcon className="size-4" />
              Вложения ({attachments.length})
            </div>
            <div className="grid grid-cols-1 gap-2">
              {attachments.map((att, idx) => renderAttachment(att, idx))}
            </div>
          </div>
        )}

        {reasoningParts.map((part: any, index: number) => (
          <Reasoning
            key={index}
            className="w-full"
            isStreaming={status === 'streaming' && index === reasoningParts.length - 1 && isLastMessage}
            duration={getReasoningDurationSeconds(part)}
            onDurationMeasured={(seconds) => persistReasoningDuration(part, seconds)}
          >
            <ReasoningTrigger />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        ))}

        {textParts.map((part: any, index: number) => {
          try {
            const parsed = JSON.parse(part.text);

            if (parsed.text && !parsed.document && !parsed.results) {
              return renderTextResponse(parsed.text, `${message.id}-text-${index}`);
            }

            if (parsed.results) {
              return (
                <div key={`${message.id}-search-${index}`} className="space-y-2">
                  {renderTextResponse(parsed.text || 'Результаты поиска:', `${message.id}-search-heading-${index}`)}
                  <div className="mt-2 space-y-2 text-sm">
                    {parsed.results.map((result: any, resultIndex: number) => (
                      <div key={resultIndex} className="p-3 bg-muted/50 rounded-lg">
                        <a
                          href={result.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {result.title}
                        </a>
                        <p className="text-xs text-muted-foreground mt-1">{result.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }

            return renderTextResponse(part.text, `${message.id}-text-${index}`);
          } catch {
            return renderTextResponse(part.text, `${message.id}-text-${index}`);
          }
        })}

        {toolParts.length > 0 && <ToolsDisplay tools={toolParts} isStreaming={isToolsStreaming} />}

        {/* Edit mode for user messages */}
        {isEditing && message.role === 'user' && (
          <div className="w-full space-y-2">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full min-h-[100px] p-3 border rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (onEdit && editText.trim()) {
                    onEdit(message.id, editText.trim());
                    setIsEditing(false);
                  }
                }}
                className="flex items-center gap-1 px-3 py-1.5 bg-primary text-black rounded-md hover:bg-primary/90 text-sm"
              >
                <Send className="size-3" />
                Отправить
              </button>
              <button
                onClick={() => setIsEditing(false)}
                className="flex items-center gap-1 px-3 py-1.5 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 text-sm"
              >
                <X className="size-3" />
                Отмена
              </button>
            </div>
          </div>
        )}

        {/* Actions for user messages */}
        {message.role === 'user' && textParts.length > 0 && status !== 'streaming' && !isEditing && (
          <Actions>
            {onEdit && (
              <Action
                onClick={() => {
                  const text = textParts
                    .map((part: any) => {
                      const { visible } = sanitizeUserText(part.text);
                      return visible || part.text;
                    })
                    .join('\n');
                  setEditText(text);
                  setIsEditing(true);
                }}
                tooltip="Редактировать"
                label="Edit"
              >
                <Pencil className="size-3" />
              </Action>
            )}
            <Action
              onClick={() => {
                const text = textParts
                  .map((part: any) => {
                    const { visible } = sanitizeUserText(part.text);
                    return visible || part.text;
                  })
                  .join('\n');
                onCopy(text, message.id);
              }}
              label={copiedId === message.id ? 'Скопировано!' : 'Copy'}
            >
              {copiedId === message.id ? <Check className="size-3" /> : <Copy className="size-3" />}
            </Action>
          </Actions>
        )}

        {/* Actions for assistant messages */}
        {message.role === 'assistant' && textParts.length > 0 && status !== 'streaming' && (
          <Actions>
            <Action onClick={() => onRegenerate(message.id)} tooltip="Перегенерировать" label="Retry">
              <RefreshCcw className="size-3" />
            </Action>
            <Action
              onClick={() => {
                const text = textParts
                  .map((part: any) => {
                    try {
                      const parsed = JSON.parse(part.text);
                      const candidate = parsed.text || part.text;
                      return sanitizeUserText(candidate).visible || candidate;
                    } catch {
                      const { visible } = sanitizeUserText(part.text);
                      return visible || part.text;
                    }
                  })
                  .join('\n');
                onCopy(text, message.id);
              }}
              label={copiedId === message.id ? 'Скопировано!' : 'Copy'}
            >
              {copiedId === message.id ? <Check className="size-3" /> : <Copy className="size-3" />}
            </Action>
          </Actions>
        )}
      </MessageContent>
    </Message>
  );
};
