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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  onQuote?: (text: string) => void;
  chatReviewBody?: Pick<ChatTransportBodyExtras, 'chatProvider' | 'chatModel' | 'useThinking'>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  anonymization?: { anonymizedText: string; mapping: Record<string, string> };
  /** Для серверной анонимизации документа перед проверкой в облаке. */
  conversationId?: string | null;
  /** Нужен серверу для проверки владения диалогом (/api/review-document). */
  userId?: string | null;
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
  onQuote,
  chatReviewBody,
  collapsed,
  onToggleCollapsed,
  anonymization,
  conversationId,
  userId,
}: DocumentPanelProps) => {
  const [copied, setCopied] = useState(false);
  const [anonView, setAnonView] = useState<{ title: string; content: string } | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  // Пары mapping для таблицы: сгруппированы по метке и отсортированы по номеру.
  const mappingRows = useMemo(() => {
    const m = anonymization?.mapping || {};
    const labelOf = (ph: string) => {
      const inner = ph.replace(/^\[/, '').replace(/\]$/, '');
      const i = inner.lastIndexOf('_');
      return i === -1 ? inner : inner.slice(0, i);
    };
    const numOf = (ph: string) => {
      const mm = ph.match(/_(\d+)\]$/);
      return mm ? Number(mm[1]) : 0;
    };
    return Object.entries(m)
      .map(([placeholder, original]) => ({ placeholder, original: String(original), label: labelOf(placeholder) }))
      .sort((a, b) =>
        a.label === b.label
          ? numOf(a.placeholder) - numOf(b.placeholder)
          : a.label.localeCompare(b.label),
      );
  }, [anonymization?.mapping]);
  const downloadTextFile = (filename: string, content: string, mime = 'text/plain') => {
    try {
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error('Не удалось скачать файл');
    }
  };
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
  // RAF throttle: limit Streamdown re-renders to one per animation frame during streaming.
  const displayContentRef = useRef(document.content);
  const [displayContent, setDisplayContent] = useState(document.content);
  const rafRef = useRef<number>(0);
  // Quote tooltip: shown when user selects text inside the document panel
  const [quoteTooltip, setQuoteTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    displayContentRef.current = document.content;
    if (!document.isStreaming) {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      setDisplayContent(document.content);
      return;
    }
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        setDisplayContent(displayContentRef.current);
        rafRef.current = 0;
      });
    }
  }, [document.content, document.isStreaming]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

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
    if (!document.isStreaming || !scrollRef.current) return;
    const el = scrollRef.current;
    // Instant scroll (no smooth) — smooth scroll in tight loops constantly restarts
    // and causes the viewport to jump to position 0. Only scroll if near bottom.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [document.content, document.isStreaming]);

  // Use document prop (not localDoc) for empty/protocol checks to avoid a one-frame lag:
  // localDoc is synced via useEffect which runs after paint, so on the render where the
  // loading overlay disappears, localDoc can still be empty while document already has content.
  const isEmpty = !document.isStreaming && !document.title && !document.content.trim().length;
  /** Реальный протокол в документе (не плейсхолдер пустой панели). */
  const hasProtocol = Boolean(document.content.trim());

  const displayTitle = (() => {
    const raw = String(document.title || '').trim();
    if (document.isStreaming) {
      return raw || 'Генерация документа…';
    }

    const generic =
      !raw ||
      raw.toLowerCase() === 'чат' ||
      raw.toLowerCase() === 'документ' ||
      raw.toLowerCase() === 'протокол' ||
      raw.toLowerCase() === 'пример документа';
    const fromContent = extractTitleFromMarkdown(document.content);
    return generic && fromContent ? fromContent : raw || 'Протокол';
  })();

  const viewContent = isEmpty ? 'Здесь будет ваш протокол.' : (editing ? draftContent : (displayContent || document.content));
  const formattedContent = useMemo(() => {
    const normalized = normalizeDocumentPanelMarkdown(viewContent);
    return formatDocumentContent(normalized);
  }, [viewContent]);

  const handleCopy = async () => {
    const raw = `# ${displayTitle}\n\n${viewContent}`;
    // Strip HTML tags so <br> doesn't appear literally in the clipboard
    const formatted = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');

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
          ...(conversationId ? { conversationId } : {}),
          ...(userId ? { userId } : {}),
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

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-6"
        onMouseDown={() => setQuoteTooltip(null)}
        onMouseUp={() => {
          if (!onQuote || editing || document.isStreaming) return;
          const sel = window.getSelection();
          const text = sel?.toString().trim() ?? '';
          if (!text || text.length > 600) return;
          const range = sel!.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          setQuoteTooltip({ text, x: rect.left + rect.width / 2, y: rect.top });
        }}
      >
        {quoteTooltip && (
          <div
            className="fixed z-50 -translate-x-1/2 -translate-y-full pointer-events-auto"
            style={{ left: quoteTooltip.x, top: quoteTooltip.y - 6 }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
          >
            <Button
              size="sm"
              variant="default"
              className="shadow-lg text-xs h-7 px-3"
              onClick={() => {
                onQuote?.(quoteTooltip.text);
                setQuoteTooltip(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              Цитировать в чат
            </Button>
          </div>
        )}
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
          <div className="relative">
            <Response
              className="document-panel-markdown prose prose-sm max-w-none dark:prose-invert"
              controls={{ table: false }}
            >
              {formattedContent}
            </Response>
            {document.isStreaming && (
              <span
                aria-hidden="true"
                className="inline-block w-[2px] h-[1em] bg-current align-middle ml-[1px] animate-[blink_1s_step-end_infinite]"
              />
            )}
          </div>
        )}
      </div>

      {((Array.isArray(attachments) && attachments.length > 0) || anonymization) && (
        <div className="border-t bg-background px-4 py-2 min-h-[104px]">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-muted-foreground">Загруженные документы</div>
          </div>
          <div className="mt-2 max-h-40 overflow-y-auto no-scrollbar pr-1">
            <div className="flex flex-wrap gap-2">
              {(attachments || []).map((att, idx) => {
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
          {anonymization && (Object.keys(anonymization.mapping || {}).length > 0 || anonymization.anonymizedText) && (
            <div className="mt-3 border-t pt-2">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Shield className="size-3.5" /> Версия для облака (без ПДн, 152-ФЗ)
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <FileText className="size-3.5 shrink-0 text-[color:var(--chart-1)]" />
                  <span className="flex-1 truncate" title="Анонимизированный текст, который уходит в облако">
                    Анонимизированная версия (.txt)
                  </span>
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 hover:bg-muted"
                    onClick={() => setAnonView({ title: 'Анонимизированная версия (уходит в облако)', content: anonymization.anonymizedText || '(пусто)' })}
                  >
                    Просмотр
                  </button>
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 hover:bg-muted"
                    onClick={() => downloadTextFile('anonymized.txt', anonymization.anonymizedText || '', 'text/plain')}
                  >
                    Скачать
                  </button>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Shield className="size-3.5 shrink-0 text-[color:var(--chart-2)]" />
                  <span className="flex-1 truncate" title="Ключ обратной подстановки (placeholder → оригинал)">
                    Mapping — ключ деанонимизации ({Object.keys(anonymization.mapping || {}).length})
                  </span>
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 hover:bg-muted"
                    onClick={() => setMappingOpen(true)}
                  >
                    Просмотр
                  </button>
                  <button
                    type="button"
                    className="rounded border px-2 py-0.5 hover:bg-muted"
                    onClick={() => downloadTextFile('mapping.map.json', JSON.stringify(anonymization.mapping || {}, null, 2), 'application/json')}
                  >
                    Скачать
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={!!anonView} onOpenChange={(o) => { if (!o) setAnonView(null); }} panelClassName="max-w-2xl w-full">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{anonView?.title}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{anonView?.content}</pre>
          </div>
        </DialogContent>
      </Dialog>

      {/* Таблица mapping — как модель анонимизировала (placeholder → оригинал). */}
      <Dialog open={mappingOpen} onOpenChange={(o) => { if (!o) setMappingOpen(false); }} panelClassName="max-w-2xl w-full">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <span className="inline-flex items-center gap-1.5">
                <Shield className="size-4 text-[color:var(--chart-2)]" />
                Как анонимизировано ({mappingRows.length})
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="mb-2 text-xs text-muted-foreground">
            Слева — плейсхолдер, который ушёл в облако вместо персональных данных; справа — исходное значение (152-ФЗ). Обратная подстановка выполняется автоматически.
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-md border">
            {mappingRows.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">Персональные данные не обнаружены.</div>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-muted/60 backdrop-blur">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Плейсхолдер</th>
                    <th className="px-3 py-2 font-medium">Оригинал (ПДн)</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingRows.map((row) => (
                    <tr key={row.placeholder} className="border-t hover:bg-muted/30">
                      <td className="whitespace-nowrap px-3 py-1.5 align-top">
                        <code className="rounded bg-[color:var(--chart-1)]/10 px-1.5 py-0.5 font-mono text-[color:var(--chart-1)]">
                          {row.placeholder}
                        </code>
                      </td>
                      <td className="px-3 py-1.5 align-top break-words">{row.original}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex justify-end pt-3">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={() => downloadTextFile('mapping.map.json', JSON.stringify(anonymization?.mapping || {}, null, 2), 'application/json')}
            >
              Скачать JSON
            </button>
          </div>
        </DialogContent>
      </Dialog>

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
