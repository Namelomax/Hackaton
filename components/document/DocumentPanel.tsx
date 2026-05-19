'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheetIcon,
  FileText,
  ImageIcon,
  Info,
  Loader,
  Paperclip,
  PencilIcon,
  PresentationIcon,
  X,
  Shield,
} from 'lucide-react';
import { toast } from 'sonner';
import { Response } from '@/components/ai-elements/response';
import { Button } from '@/components/ui/button';
import { DocumentReviewPanel } from '@/components/document/DocumentReviewPanel';
import type { DocumentReview } from '@/app/api/chat/agents/review-agent';
import type { Attachment, DocumentState } from '@/lib/document/types';
import type { ChatTransportBodyExtras } from '@/components/chat/PromptInputWrapper';
import { buildDocxMarkdown, extractTitleFromMarkdown, formatDocumentContent, normalizeDocumentPanelMarkdown, sanitizeFilename } from '@/lib/document/formatting';
import { copyTextToClipboard } from '@/lib/copyToClipboard';

type DocumentPanelProps = {
  document: DocumentState;
  onCopy?: (payload: { title: string; content: string }) => void;
  onEdit?: (payload: DocumentState) => void;
  attachments?: Attachment[];
  onSendReview?: (text: string) => void;
  chatReviewBody?: Pick<ChatTransportBodyExtras, 'chatProvider' | 'chatModel' | 'useThinking'>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

function getFileExt(name: string) {
  const n = String(name || '').trim();
  const m = n.match(/\.([A-Za-z0-9]+)$/);
  return (m?.[1] || '').toLowerCase();
}

function getAttachmentAccentClass(att: Attachment) {
  const name = att?.name || '';
  const ext = getFileExt(name);
  const mt = String(att?.mediaType || '').toLowerCase();

  if (mt.includes('pdf') || ext === 'pdf') return 'text-destructive';

  const isDocLike =
    mt.includes('word') || mt.includes('text') || ['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext);
  if (isDocLike) return 'text-[color:var(--chart-1)]';

  const isPresentation =
    mt.includes('presentation') || mt.includes('powerpoint') || ['ppt', 'pptx'].includes(ext);
  if (isPresentation) return 'text-[color:var(--chart-3)]';

  const isSpreadsheet =
    mt.includes('spreadsheet') || mt.includes('excel') || ['xls', 'xlsx', 'csv'].includes(ext);
  if (isSpreadsheet) return 'text-[color:var(--chart-2)]';

  return 'text-muted-foreground';
}

function getAttachmentIcon(att: Attachment, className?: string) {
  const name = att?.name || '';
  const ext = getFileExt(name);
  const mt = String(att?.mediaType || '').toLowerCase();

  const isImage = mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
  if (isImage) return <ImageIcon className={className ? `size-4 ${className}` : 'size-4'} />;

  const isPresentation =
    mt.includes('presentation') || mt.includes('powerpoint') || ['ppt', 'pptx'].includes(ext);
  if (isPresentation) return <PresentationIcon className={className ? `size-4 ${className}` : 'size-4'} />;

  const isSpreadsheet =
    mt.includes('spreadsheet') || mt.includes('excel') || ['xls', 'xlsx', 'csv'].includes(ext);
  if (isSpreadsheet) return <FileSpreadsheetIcon className={className ? `size-4 ${className}` : 'size-4'} />;

  const isDocLike =
    mt.includes('pdf') ||
    mt.includes('word') ||
    mt.includes('text') ||
    ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext);
  if (isDocLike) return <FileText className={className ? `size-4 ${className}` : 'size-4'} />;

  return <Paperclip className={className ? `size-4 ${className}` : 'size-4'} />;
}

function isImageAttachment(att: Attachment) {
  const name = att?.name || '';
  const ext = getFileExt(name);
  const mt = String(att?.mediaType || '').toLowerCase();
  return Boolean(
    (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) && att?.url
  );
}

export const DocumentPanel = ({
  document,
  onCopy,
  onEdit,
  attachments,
  onSendReview,
  chatReviewBody,
  collapsed,
  onToggleCollapsed,
}: DocumentPanelProps) => {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isBundling, setIsBundling] = useState(false);
  const [draftTitle, setDraftTitle] = useState(document.title);
  const [draftContent, setDraftContent] = useState(document.content);
  const [localDoc, setLocalDoc] = useState<DocumentState>(document);
  const [docxData, setDocxData] = useState<{ content: string; filename: string } | null>(null);
  const [reviewResult, setReviewResult] = useState<DocumentReview | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isReviewPanelOpen, setIsReviewPanelOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) {
      setLocalDoc(document);
      setDraftTitle(document.title);
      setDraftContent(document.content);
      
      // Проверяем наличие .docx данных в документе
      if (document.docxData) {
        setDocxData(document.docxData);
      } else if (document.content.trim() && !docxData && !document.isStreaming) {
        // Автоматически генерируем docxData если контент есть, но docxData нет
        buildDocxData(document.title || 'Протокол', document.content)
          .then(data => setDocxData(data))
          .catch(err => console.warn('Failed to auto-generate docx', err));
      }
    }
  }, [document, editing]);

  useEffect(() => {
    if (document.isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [document.content, document.isStreaming]);

  const isEmpty = !localDoc.isStreaming && !localDoc.title && !localDoc.content.trim().length;
  /** Реальный протокол в документе (не плейсхолдер пустой панели). */
  const hasProtocol = Boolean(localDoc.content.trim());

  const displayTitle = (() => {
    const raw = String(localDoc.title || '').trim();
    if (localDoc.isStreaming) {
      return raw || 'Генерация документа…';
    }

    const generic =
      !raw ||
      raw.toLowerCase() === 'чат' ||
      raw.toLowerCase() === 'документ' ||
      raw.toLowerCase() === 'протокол' ||
      raw.toLowerCase() === 'пример документа';
    const fromContent = extractTitleFromMarkdown(localDoc.content);
    return generic && fromContent ? fromContent : raw || 'Протокол';
  })();

  const viewContent = isEmpty ? 'Здесь будет ваш протокол.' : localDoc.content;
  const formattedContent = useMemo(() => {
    const normalized = normalizeDocumentPanelMarkdown(viewContent);
    return formatDocumentContent(normalized);
  }, [viewContent]);

  const handleCopy = async () => {
    const formatted = `# ${displayTitle}\n\n${viewContent}`;

    const ok = await copyTextToClipboard(formatted);
    if (ok) {
      setCopied(true);
      onCopy?.({ title: document.title, content: document.content });
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Ошибка при копировании: буфер недоступен');
      toast.error('Копирование недоступно', { description: 'Требуется HTTPS или разрешение браузера на буфер обмена.' });
    }
  };

  const handleReview = async () => {
    if (!hasProtocol) {
      toast.warning('Протокол ещё не сформирован', {
        description: 'Сначала сформируйте протокол в диалоге, затем проверьте его.',
      });
      return;
    }

    setIsReviewing(true);
    try {
      const response = await fetch('/api/review-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: localDoc.content,
          ...(chatReviewBody ?? { chatProvider: 'ollama' as const }),
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg =
          typeof result?.error === 'string'
            ? result.error
            : 'Ошибка при проверке документа';
        throw new Error(msg);
      }

      const review = result as DocumentReview;
      setReviewResult(review);
      setIsReviewPanelOpen(true);
    } catch (error) {
      console.error('Review error:', error);
      toast.error('Ошибка проверки документа', { description: String(error) });
    } finally {
      setIsReviewing(false);
    }
  };

  const persistProtocolExample = async () => {
    const formatted = `# ${displayTitle}\n\n${viewContent}`.trim();
    if (!formatted || formatted.length < 50) return;
    try {
      await fetch('/api/protocol-examples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: formatted }),
      });
    } catch (err) {
      console.warn('Failed to save protocol example', err);
    }
  };

  const handleDownloadBundle = async () => {
    if (isBundling || !hasProtocol) return;

    setIsBundling(true);
    try {
      void persistProtocolExample();
      const JSZip = (await import('jszip')).default;
      const { convertMarkdownToDocx } = await import('@mohtasham/md-to-docx');
      const zip = new JSZip();

      const docFilename = sanitizeFilename(displayTitle, 'document') + '.docx';
      const docBody = buildDocxMarkdown(displayTitle, viewContent);
      const docxBlob = await convertMarkdownToDocx(docBody);
      const docxBuffer = await docxBlob.arrayBuffer();
      zip.file(docFilename, docxBuffer);

      const list = Array.isArray(attachments) ? attachments : [];
      if (list.length > 0) {
        const folder = zip.folder('Загруженные документы');
        const usedNames = new Set<string>();

        for (const att of list) {
          const url = att?.url;
          if (!url) continue;

          const base = sanitizeFilename(att?.name || '', 'attachment');
          let candidate = base;
          let i = 1;
          while (usedNames.has(candidate)) {
            candidate = `${base}-${i++}`;
          }
          usedNames.add(candidate);

          try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const buf = await res.arrayBuffer();
            folder?.file(candidate, buf);
          } catch {
            // skip broken attachment
          }
        }
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      const objectUrl = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = objectUrl;
      link.download = sanitizeFilename(displayTitle, 'documents') + '.zip';
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } finally {
      setIsBundling(false);
    }
  };

  const handleDownloadAttachment = async (att: Attachment) => {
    const url = att?.url;
    if (!url) return;

    const filename = (att?.name || 'attachment')
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 140);

    try {
      if (url.startsWith('data:')) {
        const link = window.document.createElement('a');
        link.href = url;
        link.download = filename;
        window.document.body.appendChild(link);
        link.click();
        window.document.body.removeChild(link);
        return;
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch attachment');
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.warn('Failed to download attachment', e);
    }
  };

  const handleDownloadDocx = async () => {
    if (!hasProtocol || !docxData) return;

    try {
      void persistProtocolExample();
      const response = await fetch('/api/download-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(docxData),
      });

      if (!response.ok) throw new Error('Failed to download docx');

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = docxData.filename;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading docx:', error);
    }
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const buildDocxData = async (title: string, content: string) => {
    const { convertMarkdownToDocx } = await import('@mohtasham/md-to-docx');
    const docBody = buildDocxMarkdown(title, content);
    const docxBlob = await convertMarkdownToDocx(docBody);
    const docxBuffer = await docxBlob.arrayBuffer();
    return {
      content: arrayBufferToBase64(docxBuffer),
      filename: sanitizeFilename(title, 'document') + '.docx',
    };
  };

  const startEdit = () => {
    setEditing(true);
    setDraftTitle(localDoc.title);
    setDraftContent(localDoc.content);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftTitle(localDoc.title);
    setDraftContent(localDoc.content);
  };

  const saveEdit = async () => {
    const updated: DocumentState = {
      ...localDoc,
      title: draftTitle,
      content: draftContent,
    };
    setLocalDoc(updated);
    setEditing(false);
    try {
      const nextDocx = await buildDocxData(updated.title, updated.content);
      setDocxData(nextDocx);
      onEdit?.({ ...updated, docxData: nextDocx });
    } catch (error) {
      console.warn('Failed to rebuild docx after edit', error);
      setDocxData(null);
      onEdit?.({ ...updated, docxData: undefined });
    }
  };

  if (collapsed) {
    return (
      <div
        className={
          'flex h-full w-10 shrink-0 flex-col border-l bg-background overflow-hidden ' +
          'transition-[width] duration-200 ease-in-out'
        }
      >
        <div className="flex flex-1 items-start justify-start border-b p-2 pl-1">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="p-1 border rounded shrink-0"
            aria-label="Показать протокол"
            title="Показать протокол"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        'flex h-full flex-1 min-w-[280px] flex-col border-l bg-background shrink-0 overflow-hidden ' +
        'transition-[width] duration-200 ease-in-out'
      }
    >
      <div className="border-b py-3 pl-2 pr-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {onToggleCollapsed && (
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="shrink-0 p-1 border rounded"
                aria-label="Скрыть протокол"
                title="Скрыть протокол"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0">
            <div className="text-sm font-medium truncate">{displayTitle}</div>
            {localDoc.isStreaming && (
              <div className="text-xs text-muted-foreground">Генерация протокола…</div>
            )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editing ? (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={startEdit}
                  type="button"
                  title="Редактировать"
                  aria-label="Редактировать"
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleReview}
                  type="button"
                  title={isReviewing ? "Проверка документа..." : "Проверить документ"}
                  aria-label={isReviewing ? "Проверка документа..." : "Проверить документ"}
                  disabled={!hasProtocol || isReviewing || localDoc.isStreaming}
                >
                  {isReviewing ? (
                    <Loader className="size-4 animate-spin" />
                  ) : (
                    <Shield className="size-4" />
                  )}
                </Button>
                {reviewResult && (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setIsReviewPanelOpen(true)}
                    type="button"
                    title="Показать замечания"
                    aria-label="Показать замечания"
                  >
                    <Info className="size-4" />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleDownloadDocx}
                  type="button"
                  title="Скачать протокол (.docx)"
                  aria-label="Скачать протокол (.docx)"
                  disabled={!hasProtocol || !docxData || localDoc.isStreaming}
                >
                  <FileText className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleDownloadBundle}
                  type="button"
                  title="Скачать ZIP (документ + вложения)"
                  aria-label="Скачать ZIP (документ + вложения)"
                  disabled={!hasProtocol || !docxData || localDoc.isStreaming || isBundling}
                >
                  <Download className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  type="button"
                  title={copied ? 'Скопировано' : 'Скопировать'}
                  aria-label={copied ? 'Скопировано' : 'Скопировать'}
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={saveEdit}
                  type="button"
                  title="Сохранить"
                  aria-label="Сохранить"
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={cancelEdit}
                  type="button"
                  title="Отмена"
                  aria-label="Отмена"
                >
                  <X className="size-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto p-6">
        {editing ? (
          <div className="space-y-3">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Заголовок"
              className="w-full border rounded px-3 py-2 text-sm"
            />
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              placeholder="Markdown содержимое"
              className="w-full h-[60vh] border rounded px-3 py-2 text-sm font-mono whitespace-pre-wrap"
            />
          </div>
        ) : (
          <Response
            className="document-panel-markdown prose prose-sm max-w-none dark:prose-invert"
            controls={{ table: false }}
          >
            {formattedContent}
          </Response>
        )}
      </div>

      {Array.isArray(attachments) && attachments.length > 0 && (
        <div className="border-t bg-background px-4 py-2 min-h-[104px]">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-muted-foreground">Загруженные документы</div>
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto no-scrollbar pr-1">
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, idx) => {
                const name = att?.name || 'attachment';
                const canDownload = Boolean(att?.url);
                const extension = (att?.name || '').split('.').pop()?.toUpperCase();
                const showImage = isImageAttachment(att);
                const accent = getAttachmentAccentClass(att);

                return (
                  <div
                    key={att?.id || `${name}-${idx}`}
                    className={`group relative h-14 w-14 overflow-hidden rounded-md border bg-muted/20 transition-colors ${canDownload ? 'cursor-pointer hover:bg-muted/30' : ''}`}
                    title={name}
                    role={canDownload ? 'button' : undefined}
                    tabIndex={canDownload ? 0 : -1}
                    onClick={() => {
                      if (!canDownload) return;
                      handleDownloadAttachment(att);
                    }}
                    onKeyDown={(e) => {
                      if (!canDownload) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleDownloadAttachment(att);
                      }
                    }}
                  >
                    {showImage ? (
                      <img alt={name} className="size-full rounded-md object-cover" height={56} src={att?.url} width={56} />
                    ) : (
                      <div className="flex size-full flex-col items-center justify-center gap-1">
                        <span className={accent}>{getAttachmentIcon(att, accent)}</span>
                        <span className="text-[10px] font-medium uppercase tracking-wide">{extension || 'FILE'}</span>
                      </div>
                    )}

                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-black/60 px-1 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <span className="truncate" title={name}>
                        {name}
                      </span>
                    </div>

                    <Button
                      aria-label="Скачать файл"
                      className="-right-1.5 -top-1.5 absolute h-6 w-6 rounded-full opacity-0 group-hover:opacity-100"
                      disabled={!canDownload}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadAttachment(att);
                      }}
                      size="icon"
                      type="button"
                      variant="outline"
                      title="Скачать файл"
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {reviewResult && isReviewPanelOpen && (
        <DocumentReviewPanel
          review={reviewResult}
          onClose={() => setIsReviewPanelOpen(false)}
          onSendReview={onSendReview}
        />
      )}
    </div>
  );
};
