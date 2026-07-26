'use client';

import React, { useEffect, useState } from 'react';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Loader } from '@/components/ai-elements/loader';
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

// Убирает «утёкший» в текст tool-call publishInvestigationProtocol: {"reasonBrief":…},
// ["reasonBrief":…], ("reasonBrief":…). Закрывающую скобку ищем только в конце строки/
// текста (lookahead), чтобы не отрезать реальный текст после фрагмента и не остановиться
// на скобке внутри значения (напр. «ЦОД (центр обработки данных)»).
const LEAKED_TOOL_CALL_RE = /[[({]\s*"?reasonBrief"?\s*:[\s\S]*?[\])}](?=\s*(?:\n|$))/gi;

const stripLeakedToolCall = (text: string): string =>
  String(text ?? '')
    .replace(LEAKED_TOOL_CALL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Extracts <think>...</think> content from text into a separate reasoning string.
 * Handles both complete tags and incomplete (streaming) open tags.
 */
function extractThinkingFromText(text: string): { thinking: string | null; isThinkingOpen: boolean; rest: string } {
  // Complete: <think>...</think> at the start
  const completeMatch = text.match(/^<think>([\s\S]*?)<\/think>\n?([\s\S]*)$/);
  if (completeMatch) {
    return { thinking: completeMatch[1].trim(), isThinkingOpen: false, rest: completeMatch[2] };
  }
  // Streaming: <think> without closing tag yet
  if (text.startsWith('<think>')) {
    return { thinking: text.slice('<think>'.length).trim(), isThinkingOpen: true, rest: '' };
  }
  return { thinking: null, isThinkingOpen: false, rest: text };
}


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

const getAttachmentExtension = (att: Attachment): string => {
  const rawName = String(att.name || '').trim();
  const ext = rawName.includes('.') ? rawName.split('.').pop()?.toLowerCase() : '';

  if (ext) return ext;

  const mt = String(att.mediaType || '').toLowerCase();
  if (mt.includes('word')) return 'docx';
  if (mt.includes('presentation') || mt.includes('powerpoint')) return 'pptx';
  if (mt.includes('spreadsheet') || mt.includes('excel')) return 'xlsx';
  if (mt.includes('csv')) return 'csv';
  if (mt.includes('pdf')) return 'pdf';
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('text/')) return 'txt';

  return 'file';
};

const getReasoningDurationSeconds = (part: any): number | undefined => {
  const metadata = part?.metadata ?? {};
  const directSeconds = [
    metadata.durationSeconds,
    metadata.duration,
    metadata.thinkingDurationSeconds,
    metadata.reasoning_duration_seconds,
  ].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (typeof directSeconds === 'number') return Math.round(directSeconds);
  const durationMs = [
    metadata.durationMs,
    metadata.thinkingDurationMs,
    metadata.reasoning_duration_ms,
  ].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (typeof durationMs === 'number') return Math.max(1, Math.round(durationMs / 1000));
  return undefined;
};

const persistReasoningDuration = (part: any, seconds: number) => {
  if (!part || !Number.isFinite(seconds)) return;
  part.metadata = { ...(part.metadata ?? {}), durationSeconds: Math.max(1, Math.round(seconds)) };
};

const renderAttachment = (att: Attachment, index: number) => {
  const isImage = att.mediaType?.startsWith('image/') && att.url;
  const fallbackName = att.name || 'attachment';
  const label = getAttachmentExtension(att);
  return (
    <div
      key={att.id || index}
      className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2"
      title={fallbackName}
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
        <div className="text-xs text-muted-foreground truncate">Формат: .{label}</div>
      </div>
      {att.url && !att.url.startsWith('data:') && (
        <a
          className="text-xs text-primary hover:underline"
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


const CITATION_RX = /^\[Цитата из протокола\]:\s*«([\s\S]*?)»\s*([\s\S]*)$/;

function renderUserTextWithCitation(text: string, key: string, renderText: (t: string, k: string) => React.ReactNode) {
  const m = text.match(CITATION_RX);
  if (!m) return renderText(text, key);
  const [, cited, rest] = m;
  return (
    <div key={key} className="flex flex-col gap-1.5">
      <div className="border-l-2 border-black/50 bg-black/10 rounded-r px-2 py-1">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-black/40 mb-0.5">Цитата из протокола</div>
        <div className="text-xs italic text-black/50 line-clamp-3">«{cited}»</div>
      </div>
      {rest.trim() && renderText(rest.trim(), `${key}-rest`)}
    </div>
  );
}

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

  const rawParts = Array.isArray(message?.parts) ? message.parts : [];

  const attachments: Attachment[] = Array.isArray(message?.metadata?.attachments)
    ? message.metadata.attachments
    : rawParts
          .filter((p: any) => p?.type === 'file')
          .map((p: any) => ({
            id: p.id,
            name: p.filename,
            url: p.url,
            mediaType: p.mediaType,
          }));

  // Сырые "текстовые tool-call" не показываем — это аргументы инструмента
  // publishInvestigationProtocol, а не сообщение для пользователя. Модель «протекает»
  // ими в текст в разных обёртках: {"reasonBrief": …}, ["reasonBrief": …],
  // ("reasonBrief": …) — иногда посреди осмысленного ответа. `reasonBrief` — внутреннее
  // имя параметра, в нормальном ответе оно не встречается, поэтому такие фрагменты режем.
  // Значение бывает с вложенными кавычками/скобками (напр. «ЦОД (центр обработки данных)»),
  // поэтому закрываем фрагмент только на скобке в конце строки/текста, чтобы не отрезать
  // реальный текст, идущий следом.
  const textParts = rawParts
    .filter((part: any) => part.type === 'text')
    .map((part: any) => {
      if (message.role !== 'assistant') return part;
      const cleaned = stripLeakedToolCall(String(part.text ?? ''));
      return cleaned === part.text ? part : { ...part, text: cleaned };
    })
    .filter(
      (part: any): part is { type: 'text'; text: string } =>
        message.role !== 'assistant' || String(part.text ?? '').trim().length > 0,
    );
  const reasoningParts = rawParts.filter((part: any) => part.type === 'reasoning');
  const toolParts = rawParts.filter(
    (part: any) =>
      typeof part?.type === 'string' &&
      part.type.startsWith('tool-') &&
      !part.type.startsWith('tool-data'),
  );

  const hasVisibleAssistantText = textParts.some((p: any) => String(p?.text ?? '').trim().length > 0);

  const assistantStreamingAwaitingText =
    message.role === 'assistant' &&
    isLastMessage &&
    status === 'streaming' &&
    toolParts.length === 0 &&
    !hasVisibleAssistantText;

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
            key={`reasoning-${index}`}
            className="w-full"
            isStreaming={status === 'streaming' && index === reasoningParts.length - 1 && isLastMessage}
            duration={getReasoningDurationSeconds(part)}
            onDurationMeasured={(seconds) => persistReasoningDuration(part, seconds)}
          >
            <ReasoningTrigger />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        ))}

        {/* Рендеринг текста только если не редактируем; до первого токена — кружок, а не пустой пузырь */}
        {!isEditing && !assistantStreamingAwaitingText && textParts.map((part: any, index: number) => {
          // For assistant messages, extract <think>...</think> from the raw text before JSON parsing
          if (message.role === 'assistant') {
            const { thinking, isThinkingOpen, rest } = extractThinkingFromText(part.text ?? '');
            const isStreaming = status === 'streaming' && index === textParts.length - 1 && isLastMessage;

            const thinkingBlock = thinking !== null ? (
              <Reasoning
                key={`${message.id}-thinking-${index}`}
                className="w-full"
                isStreaming={isStreaming && isThinkingOpen}
                duration={isThinkingOpen ? undefined : undefined}
              >
                <ReasoningTrigger />
                <ReasoningContent>{thinking}</ReasoningContent>
              </Reasoning>
            ) : null;

            if (!rest.trim() && thinking !== null) {
              return thinkingBlock;
            }

            const textToRender = rest || part.text;

            let textBlock: React.ReactNode;
            try {
              const parsed = JSON.parse(textToRender);
              if (parsed.text && !parsed.document && !parsed.results) {
                textBlock = renderTextResponse(parsed.text, `${message.id}-text-${index}`);
              } else if (parsed.results) {
                textBlock = (
                  <div key={`${message.id}-search-${index}`} className="space-y-2">
                    {renderTextResponse(parsed.text || 'Результаты поиска:', `${message.id}-search-heading-${index}`)}
                    <div className="mt-2 space-y-2 text-sm">
                      {parsed.results.map((result: any, resultIndex: number) => (
                        <div key={resultIndex} className="p-3 bg-muted/50 rounded-lg">
                          <a href={result.link} target="_blank" rel="noopener noreferrer"
                            className="font-medium text-blue-600 hover:underline">{result.title}</a>
                          <p className="text-xs text-muted-foreground mt-1">{result.snippet}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              } else {
                textBlock = renderTextResponse(textToRender, `${message.id}-text-${index}`);
              }
            } catch {
              textBlock = renderTextResponse(textToRender, `${message.id}-text-${index}`);
            }

            if (thinkingBlock) {
              return (
                <div key={`${message.id}-block-${index}`} className="space-y-1">
                  {thinkingBlock}
                  {rest.trim() ? textBlock : null}
                </div>
              );
            }
            return textBlock;
          }

          // User messages — original logic
          try {
            const parsed = JSON.parse(part.text);
            if (parsed.text && !parsed.document && !parsed.results) {
              return renderUserTextWithCitation(parsed.text, `${message.id}-text-${index}`, renderTextResponse);
            }
            if (parsed.results) {
              return (
                <div key={`${message.id}-search-${index}`} className="space-y-2">
                  {renderTextResponse(parsed.text || 'Результаты поиска:', `${message.id}-search-heading-${index}`)}
                  <div className="mt-2 space-y-2 text-sm">
                    {parsed.results.map((result: any, resultIndex: number) => (
                      <div key={resultIndex} className="p-3 bg-muted/50 rounded-lg">
                        <a href={result.link} target="_blank" rel="noopener noreferrer"
                          className="font-medium text-blue-600 hover:underline">{result.title}</a>
                        <p className="text-xs text-muted-foreground mt-1">{result.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            return renderUserTextWithCitation(part.text, `${message.id}-text-${index}`, renderTextResponse);
          } catch {
            return renderUserTextWithCitation(part.text, `${message.id}-text-${index}`, renderTextResponse);
          }
        })}

        {assistantStreamingAwaitingText && (
          <div className="flex items-center gap-2 py-1 text-muted-foreground" aria-live="polite">
            <Loader size={18} />
          </div>
        )}

        {message.role === 'assistant' &&
          status !== 'streaming' &&
          !hasVisibleAssistantText &&
          !assistantStreamingAwaitingText &&
          (toolParts.length > 0 ||
            reasoningParts.length > 0 ||
            (isLastMessage && textParts.length === 0)) && (
            <Response className="text-muted-foreground text-sm">
              Ответ не удалось сформировать (модель исчерпала лимит или остановилась после
              инструментов). Отправьте сообщение снова или нажмите «Повторить».
            </Response>
          )}

        {/* ToolsDisplay скрыт: tool-вызовы не показываем пользователю */}

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
