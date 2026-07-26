'use client';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { DocumentPanel } from '@/components/document/DocumentPanel';
import type { DocumentState } from '@/lib/document/types';
import { applyDocumentPatches, type DocumentPatch } from '@/lib/documentPatches';
import { Header } from '@/components/chat/Header';
import { Sidebar } from '@/components/chat/Sidebar';
import { ConversationArea } from '@/components/chat/ConversationArea';
import { PromptInputWrapper } from '@/components/chat/PromptInputWrapper';
import { Loader } from '@/components/ai-elements/loader';
import { DEFAULT_CLOUD_CHAT_MODEL, FIXED_CHAT_MODEL } from '@/lib/chat-models';
import { copyTextToClipboard } from '@/lib/copyToClipboard';
import { toast } from 'sonner';
import { resolveMessagesFromRecord } from '@/lib/conversationMessages';
import { GuestWelcomeGuide, shouldShowGuestWelcome } from '@/components/onboarding/GuestWelcomeGuide';
import { WhatsNewDialog, shouldShowWhatsNew, markWhatsNewSeen } from '@/components/onboarding/WhatsNewDialog';

/** Убирает бинарный DOCX-блок, который старые версии сохраняли в document_content */
function stripDocxMeta(content: string): string {
  return content.replace(/---DOCX_META---[\s\S]*?---DOCX_META_END---/g, '').trim();
}

/** Не передавать пустой documentContent в PUT — иначе БД перезапишет документ пустой строкой */
function buildPersistPutBody(
  conversationId: string,
  messages: unknown[],
  documentContent?: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { conversationId, messages };
  if (typeof documentContent === 'string' && documentContent.trim().length > 0) {
    body.documentContent = documentContent;
  }
  return body;
}

export default function ChatPage() {
  // Режим работы модели: false — локальная LLM; true — облачная LLM с анонимизацией.
  const [anonymizeMode, setAnonymizeMode] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('anonymizeMode');
      if (saved === '1') setAnonymizeMode(true);
    } catch {}
  }, []);
  const handleToggleAnonymize = useCallback((next: boolean) => {
    setAnonymizeMode(next);
    try {
      localStorage.setItem('anonymizeMode', next ? '1' : '0');
    } catch {}
  }, []);

  // Показывать окно подтверждения перед отправкой в облако. Сама анонимизация
  // выполняется ВСЕГДА (на сервере) — этот флаг влияет только на предпросмотр.
  const [confirmAnonymize, setConfirmAnonymize] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('anonymizeConfirm');
      if (saved === '0') setConfirmAnonymize(false);
    } catch {}
  }, []);
  const handleToggleConfirmAnonymize = useCallback((next: boolean) => {
    setConfirmAnonymize(next);
    try {
      localStorage.setItem('anonymizeConfirm', next ? '1' : '0');
    } catch {}
  }, []);

  const chatBody = useMemo(
    () => ({
      chatProvider: anonymizeMode ? ('openrouter' as const) : ('ollama' as const),
      chatModel: anonymizeMode ? DEFAULT_CLOUD_CHAT_MODEL : FIXED_CHAT_MODEL,
      useRagContext: false,
      ragMode: 'hybrid' as const,
      useThinking: false,
      anonymize: anonymizeMode,
    }),
    [anonymizeMode],
  );

  const [authChecked, setAuthChecked] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [promptsLoaded] = useState(true);
  const bootCompletedRef = useRef(false);

  const [input, setInput] = useState('');
  const [quoteText, setQuoteText] = useState('');
  const [authUser, setAuthUser] = useState<{ id: string; username: string } | null>(null);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authOpen, setAuthOpen] = useState(false);
  const [authHintFromPrompt, setAuthHintFromPrompt] = useState(false);
  const [guestGuideOpen, setGuestGuideOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const handleAuthOpenChange = (open: boolean) => {
    setAuthOpen(open);
    if (!open) setAuthHintFromPrompt(false);
  };
  const toggleAuthMode = () => setAuthMode((prev) => (prev === 'login' ? 'register' : 'login'));
  // initialMessages теперь используется только как начальное пустое значение;
  // дальнейшая загрузка идет напрямую через setMessages из useChat
  const [initialMessages] = useState<any[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [document, setDocument] = useState<DocumentState>({
    title: '',
    content: '',
    isStreaming: false,
  });
  // Document shown in the right panel can differ from the conversation that is currently streaming.
  const [viewDocument, setViewDocument] = useState<DocumentState>({
    title: '',
    content: '',
    isStreaming: false,
  });
  /** Актуальный документ движка (для возврата в чат во время стрима — не подменять из списка). */
  const engineDocumentRef = useRef(document);
  engineDocumentRef.current = document;
  const [isChatsPanelVisible, setIsChatsPanelVisible] = useState(true);
  const [isDocumentPanelVisible, setIsDocumentPanelVisible] = useState(true);
  const selectedPromptId: string | null = null;

  /**
   * Тело запроса для regenerate/edit. ДОЛЖНО совпадать с тем, что отправляет
   * PromptInputWrapper при обычной отправке: без documentContent агент теряет
   * текущий протокол правой панели и правки «не применяются».
   */
  const buildRetryBody = () => ({
    selectedPromptId,
    documentContent: engineDocumentRef.current?.content || undefined,
    ...(conversationId ? { conversationId } : {}),
    ...chatBody,
  });

  const handleRegenerate = (messageId: string) => {
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;

    const message = messages[index];
    let newMessages;

    if (message.role === 'user') {
      newMessages = messages.slice(0, index + 1);
    } else {
      newMessages = messages.slice(0, index);
    }

    setMessages(newMessages);
    regenerate({ body: { ...buildRetryBody(), messages: newMessages } });
  };

  const handleEdit = (messageId: string, newContent: string) => {
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;
    
    const updatedMessage = {
      ...messages[index],
      parts: [{ type: 'text' as const, text: newContent }],
    };
    
    const newMessages = [...messages.slice(0, index), updatedMessage];
    
    setMessages(newMessages as any);
    regenerate({ body: { ...buildRetryBody(), messages: newMessages } });
  };

  // Custom fetch to inject userId and conversationId into every chat request body
  const [conversationsList, setConversationsList] = useState<any[]>([]);
  const conversationsListRef = useRef<any[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Chat that user is currently viewing in the UI.
  const [viewConversationId, setViewConversationId] = useState<string | null>(null);

  // Артефакты анонимизации по диалогам: { conversationId: { anonymizedText, mapping } }.
  // Показываются в списке документов (анонимизированная версия + mapping).
  type AnonArtifact = { anonymizedText: string; mapping: Record<string, string> };
  const [anonByConv, setAnonByConv] = useState<Record<string, AnonArtifact>>({});
  const handleAnonymizationReady = useCallback(
    (data: AnonArtifact & { conversationId?: string | null }) => {
      // id из колбэка — актуальный серверный id диалога; state conversationId в
      // момент preview ещё может быть старым local-... (setState не успел).
      const key = data.conversationId || conversationId || viewConversationId;
      if (!key) return;
      const { conversationId: _cid, ...artifact } = data;
      setAnonByConv((prev) => ({ ...prev, [key]: artifact }));
    },
    [conversationId, viewConversationId],
  );
  // Восстановление артефактов при переключении на диалог (после перезагрузки).
  useEffect(() => {
    const key = viewConversationId;
    if (!key || String(key).startsWith('local-')) return;
    if (anonByConv[key]) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/anonymize?conversationId=${encodeURIComponent(key)}`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json?.ok) return;
        const mapping = (json.mapping && typeof json.mapping === 'object') ? json.mapping : {};
        const anonymizedText = String(json.anonymizedText || '');
        if (Object.keys(mapping).length === 0 && !anonymizedText) return;
        setAnonByConv((prev) => (prev[key] ? prev : { ...prev, [key]: { anonymizedText, mapping } }));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [viewConversationId]);

  // Ensure that when PromptInputWrapper creates a real conversation from a local-* id,
  // both engine + view ids stay in sync.
  const setConversationIdAndView = useCallback<React.Dispatch<React.SetStateAction<string | null>>>(
    (next) => {
      setConversationId((prev) => {
        const resolved = typeof next === 'function' ? (next as any)(prev) : next;
        setViewConversationId(resolved);
        return resolved;
      });
    },
    []
  );

  const viewedConversation = useMemo(() => {
    if (!viewConversationId) return null;
    return (conversationsList || []).find((c: any) => c?.id === viewConversationId) || null;
  }, [conversationsList, viewConversationId]);

  useEffect(() => {
    conversationsListRef.current = conversationsList || [];
  }, [conversationsList]);

  const updateEngineDocument = useCallback(
    (updater: (prev: DocumentState) => DocumentState) => {
      setDocument(updater);
      // Keep the visible right-panel document in sync only when user is viewing the engine conversation.
      if (viewConversationId === conversationId) {
        setViewDocument(updater);
      }
    },
    [conversationId, viewConversationId]
  );

  // Нормализация сообщений из БД в формат UIMessage
  function coerceStoredPlainText(m: any): string {
    if (typeof m?.text === 'string') return m.text;
    if (typeof m?.content === 'string') return m.content;
    if (Array.isArray(m?.text)) {
      return m.text.map((x: any) => (typeof x === 'string' ? x : x?.text != null ? String(x.text) : '')).join('');
    }
    return '';
  }

  function toUIMessages(raw: any[]): any[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((m) => {
      const fallbackText = coerceStoredPlainText(m);
      let parts = Array.isArray(m.parts) && m.parts.length > 0 ? [...m.parts] : [];
      if (parts.length > 0) {
        parts = parts.map((p: any) => {
          if (p?.type === 'text') {
            const t = typeof p.text === 'string' ? p.text : '';
            const c = typeof p.content === 'string' ? p.content : '';
            const merged = (t && t.trim()) || c || fallbackText;
            return { ...p, type: 'text', text: merged };
          }
          return p;
        });
        const hasText = parts.some(
          (p: any) => p?.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '',
        );
        if (!hasText && fallbackText.trim()) {
          parts = [{ type: 'text', text: fallbackText }, ...parts.filter((p: any) => p?.type !== 'text')];
        }
      } else {
        parts = [{ type: 'text', text: fallbackText }];
      }
      return {
        id: m.id,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        parts,
        metadata: m.metadata || {},
      };
    });
  }

  function getLastAssistantId(uiMessages: any[]): string | null {
    if (!Array.isArray(uiMessages)) return null;
    for (let i = uiMessages.length - 1; i >= 0; i--) {
      const m = uiMessages[i];
      if (m?.role === 'assistant' && m?.id) return String(m.id);
    }
    return null;
  }

  function extractTitleFromMarkdown(markdown?: string | null): string | null {
    const text = String(markdown || '').replace(/\r\n?/g, '\n');
    if (!text.trim()) return null;
    const lines = text.split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^#\s+(.+?)\s*$/);
      if (m?.[1]) return m[1].trim();
      break;
    }
    return null;
  }

  function normalizeConversationTitle(conv: any): any {
    const existing = String(conv?.title ?? '').trim();
    const fallback = extractTitleFromMarkdown(conv?.document_content);

    // If title is missing or generic, use the document heading.
    const lower = existing.toLowerCase();
    const isGeneric =
      !existing ||
      lower === 'чат' ||
      lower === 'chat' ||
      lower === 'new conversation' ||
      lower.startsWith('conversation ');
    const nextTitle = isGeneric && fallback ? fallback : existing;
    return { ...conv, title: nextTitle || conv?.title };
  }

  const transport = useMemo(() => {
    const base = '/api/chat';
    const params: string[] = [];
    if (authUser?.id) params.push(`userId=${encodeURIComponent(authUser.id)}`);
    if (conversationId) params.push(`conversationId=${encodeURIComponent(conversationId)}`);
    const api = params.length ? `${base}?${params.join('&')}` : base;
    return new DefaultChatTransport({ api });
  }, [authUser?.id, conversationId]);

  const lastErrorSignatureRef = useRef<string>('');
  const lastErrorAtRef = useRef<number>(0);
  const errorRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function collectErrorText(err: any): string {
    if (!err) return '';
    if (typeof err === 'string') return err;
    const chunks: string[] = [];
    const push = (v: any) => {
      const s = typeof v === 'string' ? v : v ? String(v) : '';
      if (s && !chunks.includes(s)) chunks.push(s);
    };

    push(err.message);
    push(err.name);
    push((err as any).responseBody);
    push((err as any).statusCode);
    push((err as any).url);
    push((err as any).cause?.message);
    push((err as any).cause?.responseBody);
    push((err as any).cause?.statusCode);

    try {
      push(JSON.stringify(err));
    } catch {}
    return chunks.join('\n');
  }

  function isAbortLikeError(err: any): boolean {
    const text = collectErrorText(err).toLowerCase();
    const name = String(err?.name || '').toLowerCase();
    return (
      name === 'aborterror' ||
      text.includes('abort') ||
      text.includes('canceled') ||
      text.includes('cancelled')
    );
  }

  function toUserFriendlyErrorMessage(err: any): string {
    const raw = collectErrorText(err);
    const lower = raw.toLowerCase();

    // Next.js вернул HTML-страницу ошибки (необработанное исключение в /api/chat).
    // Её нельзя разбирать по подстрокам «401»/«api key» — внутри случайная разметка,
    // из-за которой пользователь получал ложное «проверь OPENROUTER_API_KEY».
    if (lower.includes('__next_error__') || lower.includes('internal server error')) {
      return (
        'Сервер не смог обработать запрос (500).\n' +
        'Чаще всего это слишком большой контекст (расшифровка + документ + история) или сбой провайдера модели. ' +
        'Попробуйте ещё раз, а если повторяется — начните новый чат или уменьшите объём вложений. Подробности — в логах сервера.'
      );
    }

    if (
      lower.includes('maximum context length') ||
      (lower.includes('context length') && lower.includes('tokens')) ||
      lower.includes('requested about')
    ) {
      return (
        'Ошибка: слишком большой контекст для модели.\n' +
        'Попробуйте: удалить часть вложений, укоротить сообщение/документ или разбить задачу на несколько запросов (по частям).'
      );
    }

    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('api key')) {
      return 'Ошибка авторизации к модели (API key). Проверь `OPENROUTER_API_KEY` и перезапусти сервер.';
    }

    if (lower.includes('429') || lower.includes('rate limit')) {
      return 'Слишком много запросов (rate limit). Подожди немного и попробуй снова.';
    }

    if (lower.includes('timeout') || lower.includes('timed out')) {
      return 'Истекло время ожидания ответа. Попробуй ещё раз.';
    }

    return 'Произошла ошибка при обращении к модели. Попробуйте ещё раз или уменьшите объём запроса.';
  }

  const chatKey = `${viewConversationId ?? conversationId ?? 'no'}-${authUser?.id ?? 'anon'}`;
  const { messages, sendMessage, status, regenerate, setMessages, stop } = useChat({
    transport,
    messages: initialMessages,
    onError: (error) => {
      console.error('Chat error:', error);
      
      const friendly = toUserFriendlyErrorMessage(error);
      const signature = friendly.trim();
      
      // Дедуп только для «эха» одной и той же ошибки в рамках одного запроса
      // (несколько onError подряд). Повтор той же ошибки в НОВОМ запросе обязан
      // показываться: иначе пользователь отправляет правку и не видит вообще
      // ничего — визуально «протоколер молчит».
      const now = Date.now();
      const isEcho =
        Boolean(signature) &&
        lastErrorSignatureRef.current === signature &&
        now - lastErrorAtRef.current < 3000;
      lastErrorAtRef.current = now;
      if (isEcho) {
        // Всё равно обеспечиваем восстановление
        if (errorRecoveryTimeoutRef.current) clearTimeout(errorRecoveryTimeoutRef.current);
        errorRecoveryTimeoutRef.current = setTimeout(() => {
          errorRecoveryTimeoutRef.current = null;
        }, 500);
        return;
      }
      lastErrorSignatureRef.current = signature;

      const errorMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        parts: [{ type: 'text', text: friendly }],
        metadata: { isError: true },
      };

      try {
        (setMessages as any)((prev: any[]) => [...(Array.isArray(prev) ? prev : []), errorMessage]);
      } catch {
        (setMessages as any)([...(Array.isArray(messages) ? messages : []), errorMessage]);
      }
      
      // Восстановление после ошибки: сбрасываем состояние через 500мс
      // Это позволяет пользователю продолжить работу даже после ошибки
      if (errorRecoveryTimeoutRef.current) clearTimeout(errorRecoveryTimeoutRef.current);
      errorRecoveryTimeoutRef.current = setTimeout(() => {
        errorRecoveryTimeoutRef.current = null;
        try {
          stop();
        } catch {}
      }, 500);
    },
    onData: (dataPart) => {
      // console.log('📥 Received data:', dataPart);

      // Server may send custom document events either directly (legacy)
      // or wrapped as an AI SDK `data` part: { type: 'data', data: { type: 'data-title', data: ... } }.
      const raw: any = dataPart as any;
      const normalized: any = raw?.type === 'data' && raw?.data && typeof raw.data.type === 'string' ? raw.data : raw;
      
      // Обработка событий документа
      if (normalized.type === 'data-title') {
        console.log('📄 Document title:', normalized.data);
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          title: String(normalized.data),
          isStreaming: true,
        }));
      }

      if (normalized.type === 'data-clear') {
        console.log('🧹 Clearing document');
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          content: '',
          isStreaming: true,
        }));
      }

      if (normalized.type === 'data-documentDelta') {
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          content: prev.content + normalized.data,
        }));
      }

      if (normalized.type === 'data-finish') {
        console.log('✅ Document finished');
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          isStreaming: false,
        }));
      }

      if (normalized.type === 'data-docx') {
        console.log('📦 DOCX data received:', normalized.data);
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          docxData: normalized.data,
        }));
      }

    },
  });

  const createLocalConversation = useCallback(() => {
    if (!authUser?.id) return null;
    const localId = `local-${Date.now()}`;
    const localConv = {
      id: localId,
      title: 'Чат',
      created: new Date().toISOString(),
      messages: [],
      local: true,
    } as any;
    setConversationsList((prev) => [localConv, ...prev]);
    setViewConversationId(localId);
    // While AI is busy in another conversation, don't touch engine state.
    if (status === 'ready') {
      setConversationId(localId);
      setMessages([]);
      // Reset engine doc on new chat
      setDocument({ title: '', content: '', isStreaming: false });
    }
    // Always reset the visible right panel for the newly viewed chat.
    setViewDocument({ title: '', content: '', isStreaming: false });
    localStorage.setItem('activeConversationId', localId);
    return localId;
  }, [authUser?.id, status, setMessages]);

  const displayMessages = useMemo(() => {
    if (!viewConversationId || viewConversationId === conversationId) return messages;
    return toUIMessages(viewedConversation?.messages || []);
  }, [messages, viewConversationId, conversationId, viewedConversation]);

  const displayStatus = viewConversationId === conversationId ? status : 'ready';

  const prepareSend = useCallback(async () => {
    if (!viewConversationId) {
      if (!authUser?.id) return conversationId ?? undefined;
      const localId = createLocalConversation();
      return localId ?? undefined;
    }
    if (viewConversationId === conversationId) return conversationId ?? undefined;

    // If another chat is still streaming, block sending to avoid mixing contexts.
    if (status !== 'ready') {
      toast.warning('ИИ ещё отвечает', { description: 'Дождитесь завершения ответа в текущем чате.' });
      return null;
    }

    const target = viewConversationId;
    setConversationId(target);
    const hydrated = toUIMessages(viewedConversation?.messages || []);
    setLastSavedAssistantId(getLastAssistantId(hydrated));
    setMessages(hydrated);
    setDocument(viewDocument);
    return target;
  }, [viewConversationId, conversationId, status, viewedConversation, viewDocument, setMessages, authUser?.id, createLocalConversation]);

  // Diagram feature removed.

  const attachedFiles = useMemo(() => {
    const collected: Array<{ id?: string; name?: string; url?: string; mediaType?: string }> = [];

    for (const message of displayMessages || []) {
      if (message?.role !== 'user') continue;

      const metaAtts = Array.isArray((message as any)?.metadata?.attachments)
        ? ((message as any).metadata.attachments as any[])
        : [];

      for (const a of metaAtts) {
        collected.push({
          id: a?.id,
          name: a?.name,
          url: a?.url,
          mediaType: a?.mediaType,
        });
      }

      if (Array.isArray((message as any)?.parts)) {
        for (const p of (message as any).parts) {
          if (p?.type !== 'file') continue;
          collected.push({
            id: p?.id,
            name: p?.filename,
            url: p?.url,
            mediaType: p?.mediaType,
          });
        }
      }
    }

    const seen = new Set<string>();
    const deduped = collected.filter((f) => {
      const key = `${String(f.url ?? '')}|${String(f.name ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped;
  }, [displayMessages]);
  useEffect(() => {
    if (!conversationId) return;
    setConversationsList((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, document_content: document.content }
          : c
      )
    );
  }, [document.content, conversationId]);

  // Панель справа может показывать другой чат, чем движок; без этого в списке сайдбара не будет актуального document_content.
  useEffect(() => {
    if (!viewConversationId || String(viewConversationId).startsWith('local-')) return;
    const text = viewDocument.content?.trim() ?? '';
    if (!text) return;
    setConversationsList((prev) =>
      prev.map((c) =>
        c.id === viewConversationId ? { ...c, document_content: viewDocument.content } : c
      )
    );
  }, [viewDocument.content, viewConversationId]);

  const [lastSavedAssistantId, setLastSavedAssistantId] = useState<string | null>(null);
  useEffect(() => {
    if (!authUser?.id || !conversationId) return;
    if (String(conversationId).startsWith('local-')) return;
    if (status !== 'ready') return;
    const last = messages.at(-1);
    if (!last || last.role !== 'assistant') return;
    if (last.id === lastSavedAssistantId) return;
    (async () => {
      try {
        // Only send documentContent if it's not empty, otherwise undefined to avoid overwriting with empty string if not intended
        // But here we want to save whatever is in the state.
        // If the state is empty but DB has content, we might overwrite it with empty.
        // However, we load content on mount/select. So state should be in sync.
        
        const resp = await fetch('/api/conversations', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPersistPutBody(conversationId, messages, document.content)),
        });
        const j = await resp.json();
        if (j?.success) {
          setLastSavedAssistantId(last.id);
          setConversationsList(prev => prev.map(conv => conv.id === conversationId ? { ...conv, messages: messages, document_content: document.content } : conv));
        }
      } catch (e) {
        console.warn('Failed to persist conversation after finish', e);
      }
    })();
  }, [status, messages, authUser?.id, conversationId, lastSavedAssistantId, document.content]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('authUser');
      if (raw) setAuthUser(JSON.parse(raw));
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;

    // Полная памятка — только гостю при первом визите.
    const guestGuide = !authUser && shouldShowGuestWelcome();
    setGuestGuideOpen(guestGuide);

    // Плашка новостей «Что нового» — всем остальным (вошедшим и вернувшимся
    // гостям) один раз на версию. Первому гостю её не показываем: та же новость
    // уже есть блоком в памятке — сразу помечаем как просмотренную.
    if (guestGuide) {
      markWhatsNewSeen();
      setWhatsNewOpen(false);
    } else if (shouldShowWhatsNew()) {
      setWhatsNewOpen(true);
    }
  }, [authChecked, authUser]);

  // When authUser is present, fetch conversations
  useEffect(() => {
    if (!authChecked) return;
    if (!authUser?.id) {
      setConversationsLoaded(true);
      return;
    }
    (async () => {
      try {
        const resp = await fetch(`/api/conversations?userId=${encodeURIComponent(authUser.id)}`);
        const j = await resp.json();
        if (j?.success) {
            const convs = (j.conversations || []).map((c: any) =>
              normalizeConversationTitle({
                ...c,
                messages: resolveMessagesFromRecord(c.messages, c.messages_raw),
              }),
            );
            setConversationsList(convs);
            const savedConvId = localStorage.getItem('activeConversationId');
            let activeConv = null;
            
            // Важно: брать из `convs`, а не из `j.conversations` — в `convs` уже подставлены
            // сообщения из `messages_raw`, если поле `messages` в Surreal пришло пустым.
            if (savedConvId && convs.length > 0) {
              activeConv = convs.find((c: any) => c.id === savedConvId) ?? null;
            }

            if (!activeConv && convs.length > 0) {
              activeConv = convs[0];
            }
            
            if (activeConv) {
              setConversationId(activeConv.id);
              setViewConversationId(activeConv.id);
              const hydrated = toUIMessages(activeConv.messages);
              setLastSavedAssistantId(getLastAssistantId(hydrated));
              setMessages(hydrated);
              
              // Restore document content
              if (activeConv.document_content) {
                const cleanContent = stripDocxMeta(activeConv.document_content);
                const derived = extractTitleFromMarkdown(cleanContent);
                const nextDoc = {
                  title: (activeConv.title && String(activeConv.title).trim().toLowerCase() !== 'чат')
                    ? activeConv.title
                    : (derived || 'Протокол'),
                  content: cleanContent,
                  isStreaming: false,
                } as DocumentState;
                setDocument(nextDoc);
                setViewDocument(nextDoc);
              } else {
                const emptyDoc = { title: '', content: '', isStreaming: false } as DocumentState;
                setDocument(emptyDoc);
                setViewDocument(emptyDoc);
              }

              localStorage.setItem('activeConversationId', activeConv.id);
            } else {
                      setConversationsList([]);
                      setConversationId(null);
                      setViewConversationId(null);
            }
        }
      } catch (e) {
        console.warn('Failed to fetch conversations on load', e);
      } finally {
        setConversationsLoaded(true);
      }
    })();
  }, [authChecked, authUser?.id]);

  const handleAuth = async () => {
    if (!authUsername || !authPassword) return;
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: authMode, username: authUsername, password: authPassword }),
      });
      const json = await res.json();
      if (json?.success && json.user) {
        setAuthUser(json.user);
        localStorage.setItem('authUser', JSON.stringify(json.user));
        setAuthPassword('');
        // Don't block the initial loading overlay after explicit auth.
        setConversationsLoaded(true);
        // Load last conversation
        if (Array.isArray(json.conversations) && json.conversations.length > 0) {
          try {
            const convs = json.conversations.map((c: any) => ({
              ...c,
              messages: resolveMessagesFromRecord(c.messages, c.messages_raw),
            }));
            setConversationsList(convs);
            const first = convs[0];
            if (first) {
              setConversationId(first.id ?? null);
              setViewConversationId(first.id ?? null);
              const hydrated = toUIMessages(first.messages);
              setLastSavedAssistantId(getLastAssistantId(hydrated));
              setMessages(hydrated);
              
              // Restore document content on login
              if (first.document_content) {
                const nextDoc = {
                  title: first.title || 'Протокол',
                  content: stripDocxMeta(first.document_content),
                  isStreaming: false,
                } as DocumentState;
                setDocument(nextDoc);
                setViewDocument(nextDoc);
              } else {
                const emptyDoc = { title: '', content: '', isStreaming: false } as DocumentState;
                setDocument(emptyDoc);
                setViewDocument(emptyDoc);
              }
            }
          } catch (e) {
            console.warn('Failed to normalize conversations from auth response', e);
          }
        }
        if ((!json.conversations || json.conversations.length === 0) && json.user) {
            const resp = await fetch(`/api/conversations?userId=${encodeURIComponent(json.user.id)}`);
            const j = await resp.json();
            if (j?.success) {
              const merged = (j.conversations || []).map((c: any) => ({
                ...c,
                messages: resolveMessagesFromRecord(c.messages, c.messages_raw),
              }));
              setConversationsList(merged);
            }
        }
      } else {
        toast.error('Ошибка входа', { description: json?.message || 'Неверный логин или пароль.' });
      }
    } catch (err) {
      console.error(err);
      toast.error('Ошибка сети', { description: 'Не удалось выполнить запрос. Проверьте соединение.' });
    }
  };

  const handleLogout = () => {
    setAuthUser(null);
    localStorage.removeItem('authUser');
    localStorage.removeItem('activeConversationId');
    setConversationsList([]);
    setConversationId(null);
    setViewConversationId(null);
    setMessages([]);
    setDocument({ title: '', content: '', isStreaming: false });
    setViewDocument({ title: '', content: '', isStreaming: false });
    setInput('');
    setLastSavedAssistantId(null);
    // Don't block the initial loading overlay after logout.
    setConversationsLoaded(true);
  };

  const isBooting = (() => {
    if (bootCompletedRef.current) return false;
    const ready = authChecked && promptsLoaded && conversationsLoaded;
    if (ready) bootCompletedRef.current = true;
    return !ready;
  })();

  const removeConversationFromState = (convId: string) => {
    const prev = conversationsListRef.current || [];
    const updated = prev.filter((c) => c.id !== convId);
    setConversationsList(updated);

    if (viewConversationId === convId) {
      if (updated.length > 0) {
        const nextConv = updated[0];
        setViewConversationId(nextConv.id ?? null);
        if (nextConv?.id) localStorage.setItem('activeConversationId', nextConv.id);
        // Sync right panel to next conversation's document (or clear it)
        const nextDocContent = stripDocxMeta(nextConv?.document_content || '');
        if (nextDocContent) {
          const derived = extractTitleFromMarkdown(nextDocContent);
          setViewDocument({
            title: nextConv.title || derived || 'Документ',
            content: nextDocContent,
            isStreaming: false,
          });
        } else {
          setViewDocument({ title: '', content: '', isStreaming: false });
        }
      } else {
        setViewConversationId(null);
        localStorage.removeItem('activeConversationId');
        setViewDocument({ title: '', content: '', isStreaming: false });
      }
    }

    if (conversationId === convId) {
      if (updated.length > 0) {
        const nextConv = updated[0];
        setConversationId(nextConv.id ?? null);
        if (nextConv?.messages) {
          setMessages(toUIMessages(nextConv.messages));
        } else {
          setMessages([]);
        }
        if (nextConv?.id) {
          localStorage.setItem('activeConversationId', nextConv.id);
        }
        // Sync engine document to next conversation's document (or clear it)
        const nextDocContent = stripDocxMeta(nextConv?.document_content || '');
        if (nextDocContent) {
          const derived = extractTitleFromMarkdown(nextDocContent);
          const nextDoc = { title: nextConv.title || derived || 'Документ', content: nextDocContent, isStreaming: false } as DocumentState;
          setDocument(nextDoc);
          // Only overwrite view panel if it wasn't already handled by the viewConversationId block above
          if (viewConversationId !== convId) setViewDocument(nextDoc);
        } else {
          setDocument({ title: '', content: '', isStreaming: false });
          if (viewConversationId !== convId) setViewDocument({ title: '', content: '', isStreaming: false });
        }
      } else {
        setConversationId(null);
        setMessages([]);
        localStorage.removeItem('activeConversationId');
        setDocument({ title: '', content: '', isStreaming: false });
        setViewDocument({ title: '', content: '', isStreaming: false });
      }
    }
  };

  const handleRenameConversation = async (conv: any) => {
    let newTitle = prompt('Введите новое название чата', conv.title || 'Чат');
    if (newTitle === null) return;
    newTitle = newTitle.trim();
    if (!newTitle) return;

    if (String(conv.id).startsWith('local-')) {
      setConversationsList(prev => prev.map(c => c.id === conv.id ? { ...c, title: newTitle } : c));
      return;
    }

    try {
      const resp = await fetch('/api/conversations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conv.id, title: newTitle }),
      });
      const j = await resp.json();
      if (!j?.success) {
        throw new Error(j?.message || 'rename failed');
      }
      const updated = j.conversation;
      setConversationsList(prev => prev.map(c => c.id === conv.id ? { ...c, title: updated?.title ?? newTitle } : c));
    } catch (e) {
      console.error('Failed to rename conversation', e);
      setConversationsList(prev => prev.map(c => c.id === conv.id ? { ...c, title: conv.title } : c));
      return;
    }
  };

  const handleDeleteConversation = async (conv: any) => {
    if (!conv?.id) return;

    const doDelete = async () => {
      if (String(conv.id).startsWith('local-')) {
        removeConversationFromState(conv.id);
        return;
      }
      if (!authUser?.id) {
        toast.warning('Необходима авторизация', { description: 'Войдите, чтобы удалять сохранённые чаты.' });
        return;
      }
      try {
        const resp = await fetch('/api/conversations', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conv.id, userId: authUser.id }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || !j?.success) throw new Error(j?.message || 'delete failed');
        removeConversationFromState(conv.id);
        toast.success('Чат удалён');
      } catch (err) {
        console.error('Failed to delete conversation', err);
        toast.error('Не удалось удалить чат', { description: 'Попробуйте ещё раз.' });
      }
    };

    toast('Удалить этот чат?', {
      description: conv.title ? `«${conv.title}»` : undefined,
      action: { label: 'Удалить', onClick: doDelete },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  const handleCopy = async (text: string, id: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } else {
      console.error('Clipboard: не удалось скопировать');
      toast.error('Копирование недоступно', { description: 'Нужен HTTPS или разрешение браузера на буфер обмена.' });
    }
  };

  const handleDocumentEdit = async (updated: DocumentState) => {
    console.log('[handleDocumentEdit] Starting edit save:', {
      viewConversationId,
      conversationId,
      title: updated.title,
      contentLength: updated.content.length,
    });

    // Всегда обновляем оба состояния документа, чтобы ИИ использовал актуальную версию
    setViewDocument(updated);
    setDocument(updated);

    // Update local conversations list state
    if (viewConversationId) {
      setConversationsList((prev) => {
        const newList = prev.map((c) =>
          c.id === viewConversationId ? { ...c, document_content: updated.content } : c
        );
        console.log('[handleDocumentEdit] Updated conversationsList:', {
          found: newList.some(c => c.id === viewConversationId),
          newContent: newList.find(c => c.id === viewConversationId)?.document_content?.slice(0, 100),
        });
        return newList;
      });
    }

    // Persist to backend if conversation is saved
    if (viewConversationId && !String(viewConversationId).startsWith('local-')) {
      try {
        const messagesForPut = viewConversationId === conversationId
          ? messages
          : toUIMessages(viewedConversation?.messages || []);
        
        console.log('[handleDocumentEdit] Saving to backend:', {
          conversationId: viewConversationId,
          hasMessages: !!messagesForPut,
          contentLength: updated.content.length,
        });
        
        const resp = await fetch('/api/conversations', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: viewConversationId, messages: messagesForPut, documentContent: updated.content }),
        });
        const result = await resp.json();
        console.log('[handleDocumentEdit] Backend save result:', result);
      } catch (e) {
        console.error('[handleDocumentEdit] Failed to persist document edit', e);
      }
    } else {
      console.log('[handleDocumentEdit] Skipping backend save (local conversation or no viewConversationId)');
    }
  };

  const handleNewLocalConversation = () => {
    createLocalConversation();
  };

  const handleSelectConversation = (conversation: any) => {
    if (!conversation?.id) return;

    console.log('[handleSelectConversation] Switching to conversation:', {
      id: conversation.id,
      title: conversation.title,
      hasDocumentContent: !!conversation.document_content,
      documentContentPreview: conversation.document_content?.slice(0, 100),
    });

    const switchingAway = conversation.id !== conversationId;
    // Save current conversation before switching (сообщения); documentContent только если не пустой — не затирать БД.
    if (
      switchingAway &&
      conversationId &&
      !String(conversationId).startsWith('local-') &&
      authUser?.id &&
      messages.length > 0
    ) {
      console.log('[handleSelectConversation] Saving current conversation before switch:', {
        conversationId,
        documentContentPreview: document.content?.slice(0, 100),
        omitEmptyDoc: !document.content?.trim(),
      });
      fetch('/api/conversations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPersistPutBody(conversationId, messages, document.content)),
      }).catch((err) => console.warn('Failed to save conversation on switch', err));
    }

    // Always change the viewed chat immediately.
    setViewConversationId(conversation.id);
    localStorage.setItem('activeConversationId', conversation.id);

    // Обновляем conversation из conversationsList, чтобы получить актуальный document_content
    const conversationFromList = conversationsList.find((c) => c.id === conversation.id);
    const documentContentToUse = stripDocxMeta(
      conversationFromList?.document_content || conversation.document_content || ''
    ) || undefined;
    
    console.log('[handleSelectConversation] Using documentContent:', {
      fromList: !!conversationFromList?.document_content,
      fromConv: !!conversation.document_content,
      contentLength: documentContentToUse?.length,
    });

    const rejoinEngineChatWhileStreaming =
      Boolean(status !== 'ready' && conversationId && conversation.id === conversationId);

    // Update the visible document panel for the selected chat.
    if (rejoinEngineChatWhileStreaming) {
      // Правая панель: живое состояние движка, а не снимок из списка (во время стрима).
      setViewDocument({ ...engineDocumentRef.current });
    } else if (documentContentToUse) {
      const derived = extractTitleFromMarkdown(documentContentToUse);
      const newDoc = {
        title: (conversation.title && String(conversation.title).trim().toLowerCase() !== 'чат')
          ? conversation.title
          : (derived || 'Документ'),
        content: documentContentToUse,
        isStreaming: false,
      } as DocumentState;
      console.log('[handleSelectConversation] Setting viewDocument:', {
        title: newDoc.title,
        contentLength: newDoc.content.length,
      });
      setViewDocument(newDoc);
    } else {
      console.log('[handleSelectConversation] No document_content, setting empty doc');
      setViewDocument({ title: '', content: '', isStreaming: false });
    }

    // If AI is busy in another chat, do NOT change engine conversation or messages.
    if (status !== 'ready' && conversationId && conversation.id !== conversationId) {
      console.log('[handleSelectConversation] AI is busy, not switching engine conversation');
      return;
    }

    // Otherwise switch the engine to this chat (safe).
    setConversationId(conversation.id);

    // Не подменять сообщения из БД, если пользователь вернулся в тот же чат, где ещё идёт ответ —
    // иначе optimistic user + частичный assistant пропадут из useChat.
    if (!rejoinEngineChatWhileStreaming) {
      const hydrated = toUIMessages(conversation.messages);
      setLastSavedAssistantId(getLastAssistantId(hydrated));
      setMessages(hydrated);

      // Keep engine document in sync when engine chat changes.
      if (documentContentToUse) {
        const derived = extractTitleFromMarkdown(documentContentToUse);
        const nextDoc = {
          title: (conversation.title && String(conversation.title).trim().toLowerCase() !== 'чат')
            ? conversation.title
            : (derived || 'Документ'),
          content: documentContentToUse,
          isStreaming: false,
        } as DocumentState;
        console.log('[handleSelectConversation] Setting engine document:', {
          title: nextDoc.title,
          contentLength: nextDoc.content.length,
        });
        setDocument(nextDoc);
        setViewDocument(nextDoc);
      } else {
        const emptyDoc = { title: '', content: '', isStreaming: false } as DocumentState;
        setDocument(emptyDoc);
        setViewDocument(emptyDoc);
      }
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background">

      <GuestWelcomeGuide open={guestGuideOpen} />
      <WhatsNewDialog open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />

      {isBooting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader size={18} />
            <span>Загрузка…</span>
          </div>
        </div>
      )}

      <Header
        authUser={authUser}
        authUsername={authUsername}
        authPassword={authPassword}
        authMode={authMode}
        authOpen={authOpen}
        setAuthOpen={handleAuthOpenChange}
        onAuth={handleAuth}
        onLogout={handleLogout}
        setAuthUsername={setAuthUsername}
        setAuthPassword={setAuthPassword}
        setAuthMode={setAuthMode}
        toggleAuthMode={toggleAuthMode}
        showAuthHint={authHintFromPrompt}
        anonymizeMode={anonymizeMode}
        onToggleAnonymize={handleToggleAnonymize}
        anonymizeConfirm={confirmAnonymize}
        onToggleAnonymizeConfirm={handleToggleConfirmAnonymize}
      />

      {/* Основная область */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          conversations={conversationsList}
          activeId={viewConversationId}
          onSelect={handleSelectConversation}
          onNewLocal={handleNewLocalConversation}
          onRename={handleRenameConversation}
          onDelete={handleDeleteConversation}
          collapsed={!isChatsPanelVisible}
          onToggleCollapsed={() => setIsChatsPanelVisible((v) => !v)}
        />
        {/* Центральная часть — чат (расширяется, когда панель протокола свёрнута) */}
        <div
          className={
            `flex flex-col border-r min-w-0 transition-[width,flex] duration-200 ease-in-out ` +
            (isDocumentPanelVisible ? 'w-[600px] shrink-0' : 'flex-1')
          }
        >
          <ConversationArea
            chatKey={chatKey}
            messages={displayMessages}
            status={displayStatus}
            copiedId={copiedId}
            onRegenerate={(id) => {
              if (viewConversationId !== conversationId) return;
              handleRegenerate(id);
            }}
            onCopy={handleCopy}
            onEdit={(id, content) => {
              if (viewConversationId !== conversationId) return;
              handleEdit(id, content);
            }}
          />
          {/* Поле ввода и менеджер промптов */}
          <div className="border-t px-4 py-2 min-h-[104px]">
            <div className="max-w-3xl mx-auto">
              <PromptInputWrapper
                className="w-full"
                input={input}
                setInput={setInput}
                quoteText={quoteText}
                setQuoteText={setQuoteText}
                status={status}
                authUser={authUser}
                conversationId={conversationId}
                setConversationId={setConversationIdAndView}
                setConversationsList={setConversationsList}
                setMessages={setMessages}
                sendMessage={sendMessage}
                stop={stop}
                selectedPromptId={selectedPromptId}
                documentContent={document.content}
                prepareSend={prepareSend}
                onUserMessageQueued={undefined}
                chatBody={chatBody}
                anonymizeMode={anonymizeMode}
                anonymizeConfirm={confirmAnonymize}
                onAnonymizationReady={handleAnonymizationReady}
                onOpenAuthDialog={() => {
                  setAuthMode('login');
                  setAuthHintFromPrompt(true);
                  setAuthOpen(true);
                }}
              />
            </div>
          </div>
        </div>
        {/* Правая часть — протокол */}
        <DocumentPanel
          key={viewConversationId ?? 'no-conv'}
          document={viewDocument}
          onEdit={handleDocumentEdit}
          attachments={attachedFiles}
          anonymization={(viewConversationId && anonByConv[viewConversationId]) || (conversationId && anonByConv[conversationId]) || undefined}
          onSendReview={(text) => setInput(text)}
          onQuote={(text) => setQuoteText(text)}
          chatReviewBody={chatBody}
          conversationId={viewConversationId ?? conversationId}
          collapsed={!isDocumentPanelVisible}
          onToggleCollapsed={() => setIsDocumentPanelVisible((v) => !v)}
        />
      </div>
    </div>
  );
}