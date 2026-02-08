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

export default function ChatPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [promptsLoaded] = useState(true);
  const bootCompletedRef = useRef(false);

  const [input, setInput] = useState('');
  const [authUser, setAuthUser] = useState<{ id: string; username: string } | null>(null);
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
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
  const [isChatsPanelVisible, setIsChatsPanelVisible] = useState(true);
  const selectedPromptId: string | null = null;

  const handleRegenerate = (messageId: string) => {
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;
    
    const message = messages[index];
    let newMessages;
    
    if (message.role === 'user') {
      // If user message, keep it and remove everything after
      newMessages = messages.slice(0, index + 1);
    } else {
      // If assistant message, remove it and everything after
      newMessages = messages.slice(0, index);
    }
    
    setMessages(newMessages);
    // Force reload with the truncated history
    regenerate({ body: { messages: newMessages } });
  };

  const handleEdit = (messageId: string, newContent: string) => {
    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return;
    
    // Create updated message with new content
    const updatedMessage = {
      ...messages[index],
      parts: [{ type: 'text' as const, text: newContent }],
    };
    
    // Keep messages before this one, add the edited message, remove everything after
    const newMessages = [...messages.slice(0, index), updatedMessage];
    
    setMessages(newMessages as any);
    // Trigger regeneration with the edited message
    regenerate({ body: { messages: newMessages } });
  };

  // Custom fetch to inject userId and conversationId into every chat request body
  const [conversationsList, setConversationsList] = useState<any[]>([]);
  const conversationsListRef = useRef<any[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Chat that user is currently viewing in the UI.
  const [viewConversationId, setViewConversationId] = useState<string | null>(null);

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
  function toUIMessages(raw: any[]): any[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(m => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      parts: Array.isArray(m.parts) && m.parts.length > 0
        ? m.parts
        : [{ type: 'text', text: m.text || '' }],
      metadata: m.metadata || {},
    }));
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
    const isGeneric = !existing || existing.toLowerCase() === 'чат' || existing.toLowerCase() === 'chat';
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
      if (isAbortLikeError(error)) return;

      const friendly = toUserFriendlyErrorMessage(error);
      const signature = friendly.trim();
      if (signature && lastErrorSignatureRef.current === signature) return;
      lastErrorSignatureRef.current = signature;

      const errorMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        parts: [{ type: 'text', text: friendly }],
        metadata: { isError: true },
      };

      try {
        // useChat setMessages can accept a functional updater; cast to avoid type mismatch.
        (setMessages as any)((prev: any[]) => [...(Array.isArray(prev) ? prev : []), errorMessage]);
      } catch {
        (setMessages as any)([...(Array.isArray(messages) ? messages : []), errorMessage]);
      }
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

      if (normalized.type === 'data-documentPatch') {
        const patch = normalized.data as DocumentPatch;
        updateEngineDocument((prev: DocumentState) => ({
          ...prev,
          // Apply patch without clearing the document
          content: applyDocumentPatches(prev.content || '', [patch]),
          isStreaming: true,
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

  const displayMessages = useMemo(() => {
    if (!viewConversationId || viewConversationId === conversationId) return messages;
    return toUIMessages(viewedConversation?.messages || []);
  }, [messages, viewConversationId, conversationId, viewedConversation]);

  const displayStatus = viewConversationId === conversationId ? status : 'ready';

  const prepareSend = useCallback(async () => {
    if (!viewConversationId) return conversationId;
    if (viewConversationId === conversationId) return conversationId;

    // If another chat is still streaming, block sending to avoid mixing contexts.
    if (status !== 'ready') {
      alert('Сейчас ИИ отвечает в другом чате. Дождитесь завершения ответа, прежде чем отправлять сообщение здесь.');
      return null;
    }

    const target = viewConversationId;
    setConversationId(target);
    const hydrated = toUIMessages(viewedConversation?.messages || []);
    setLastSavedAssistantId(getLastAssistantId(hydrated));
    setMessages(hydrated);
    setDocument(viewDocument);
    return target;
  }, [viewConversationId, conversationId, status, viewedConversation, viewDocument, setMessages]);

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
          body: JSON.stringify({ conversationId, messages, documentContent: document.content }),
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
            const convs = (j.conversations || []).map((c: any) => {
              let msgs = c.messages;
              if ((!Array.isArray(msgs) || msgs.length === 0) && c.messages_raw) {
                  const parsed = JSON.parse(c.messages_raw);
                  if (Array.isArray(parsed)) msgs = parsed;
              }
              return normalizeConversationTitle({ ...c, messages: msgs });
            });
            setConversationsList(convs);
            const savedConvId = localStorage.getItem('activeConversationId');
            let activeConv = null;
            
            if (savedConvId && j.conversations) {
              activeConv = j.conversations.find((c: any) => c.id === savedConvId);
            }
            
            if (!activeConv && j.conversations && j.conversations.length > 0) {
              activeConv = j.conversations[0];
            }
            
            if (activeConv) {
              setConversationId(activeConv.id);
              setViewConversationId(activeConv.id);
              const hydrated = toUIMessages(activeConv.messages);
              setLastSavedAssistantId(getLastAssistantId(hydrated));
              setMessages(hydrated);
              
              // Restore document content
              if (activeConv.document_content) {
                const derived = extractTitleFromMarkdown(activeConv.document_content);
                const nextDoc = {
                  title: (activeConv.title && String(activeConv.title).trim().toLowerCase() !== 'чат')
                    ? activeConv.title
                    : (derived || 'Документ'),
                  content: activeConv.document_content,
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
            const convs = json.conversations.map((c: any) => {
              let msgs = c.messages;
              if ((!Array.isArray(msgs) || msgs.length === 0) && c.messages_raw) {
                  const parsed = JSON.parse(c.messages_raw);
                  if (Array.isArray(parsed)) msgs = parsed;
              }
              return { ...c, messages: msgs };
            });
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
                  title: first.title || 'Документ',
                  content: first.document_content,
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
            if (j?.success) setConversationsList(j.conversations || []);
        }
      } else {
        alert(json?.message || 'Auth failed');
      }
    } catch (err) {
      console.error(err);
      alert('Request failed');
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
    const confirmed = window.confirm('Удалить этот чат?');
    if (!confirmed) return;

    if (String(conv.id).startsWith('local-')) {
      removeConversationFromState(conv.id);
      return;
    }

    if (!authUser?.id) {
      alert('Необходимо войти, чтобы удалить сохранённый чат');
      return;
    }

    try {
      const resp = await fetch('/api/conversations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conv.id, userId: authUser.id }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || !j?.success) {
        throw new Error(j?.message || 'delete failed');
      }
      removeConversationFromState(conv.id);
    } catch (err) {
      console.error('Failed to delete conversation', err);
      alert('Не удалось удалить чат');
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDocumentEdit = async (updated: DocumentState) => {
    setViewDocument(updated);
    if (viewConversationId === conversationId) {
      setDocument(updated);
    }

    // Update local conversations list state
    if (viewConversationId) {
      setConversationsList((prev) =>
        prev.map((c) =>
          c.id === viewConversationId ? { ...c, document_content: updated.content } : c
        )
      );
    }

    // Persist to backend if conversation is saved
    if (viewConversationId && !String(viewConversationId).startsWith('local-')) {
      try {
        const messagesForPut = viewConversationId === conversationId
          ? messages
          : toUIMessages(viewedConversation?.messages || []);
        await fetch('/api/conversations', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: viewConversationId, messages: messagesForPut, documentContent: updated.content }),
        });
      } catch (e) {
        console.warn('Failed to persist document edit', e);
      }
    }
  };
//asd
  const handleNewLocalConversation = () => {
    if (!authUser?.id) return;
    const localId = `local-${Date.now()}`;
    const localConv = {
      id: localId,
      title: `Новый чат ${new Date().toLocaleTimeString()}`,
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
  };

  const handleSelectConversation = (conversation: any) => {
    if (!conversation?.id) return;

    // Save current conversation state before switching (prevent message loss)
    if (conversationId && !String(conversationId).startsWith('local-') && authUser?.id && messages.length > 0) {
      // Fire and forget - save current messages to avoid losing user's last message
      fetch('/api/conversations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, messages, documentContent: document.content }),
      }).catch(err => console.warn('Failed to save conversation on switch', err));
    }

    // Always change the viewed chat immediately.
    setViewConversationId(conversation.id);
    localStorage.setItem('activeConversationId', conversation.id);

    // Update the visible document panel for the selected chat.
    if (conversation.document_content) {
      const derived = extractTitleFromMarkdown(conversation.document_content);
      setViewDocument({
        title: (conversation.title && String(conversation.title).trim().toLowerCase() !== 'чат')
          ? conversation.title
          : (derived || 'Документ'),
        content: conversation.document_content,
        isStreaming: false,
      });
    } else {
      setViewDocument({ title: '', content: '', isStreaming: false });
    }

    // If AI is busy in another chat, do NOT change engine conversation or messages.
    if (status !== 'ready' && conversationId && conversation.id !== conversationId) {
      return;
    }

    // Otherwise switch the engine to this chat (safe).
    setConversationId(conversation.id);
    const hydrated = toUIMessages(conversation.messages);
    setLastSavedAssistantId(getLastAssistantId(hydrated));
    setMessages(hydrated);

    // Keep engine document in sync when engine chat changes.
    if (conversation.document_content) {
      const derived = extractTitleFromMarkdown(conversation.document_content);
      const nextDoc = {
        title: (conversation.title && String(conversation.title).trim().toLowerCase() !== 'чат')
          ? conversation.title
          : (derived || 'Документ'),
        content: conversation.document_content,
        isStreaming: false,
      } as DocumentState;
      setDocument(nextDoc);
      setViewDocument(nextDoc);
    } else {
      const emptyDoc = { title: '', content: '', isStreaming: false } as DocumentState;
      setDocument(emptyDoc);
      setViewDocument(emptyDoc);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background">

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
        onAuth={handleAuth}
        onLogout={handleLogout}
        setAuthUsername={setAuthUsername}
        setAuthPassword={setAuthPassword}
        toggleAuthMode={toggleAuthMode}
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
        {/* Центральная часть — чат */}
        <div className="flex flex-col w-[600px] border-r shrink-0">
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
          <div className="border-t p-4">
            <div className="max-w-3xl mx-auto space-y-3">
              <PromptInputWrapper
                className="w-full"
                input={input}
                setInput={setInput}
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
              />
            </div>
          </div>
        </div>
        {/* Правая часть — документ */}
        <DocumentPanel document={viewDocument} onEdit={handleDocumentEdit} attachments={attachedFiles} />
      </div>
    </div>
  );
}