'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { PlusIcon, PencilIcon, Trash2Icon } from 'lucide-react';

type Prompt = {
  id: string;
  title: string;
  content: string;
  isDefault: boolean;
  ownerId?: string | null;
};

export function PromptsManager({ 
  className, 
  onPromptSelect,
  userId,
  onReady,
}: { 
  className?: string;
  onPromptSelect?: (content: string, prompt: Prompt) => void | Promise<void>;
  userId?: string | null;
  onReady?: () => void;
}) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const didSignalReadyRef = useRef(false);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const persistSelection = useCallback(async (id: string) => {
    if (!id) return;

    if (userId) {
      try {
        const res = await fetch('/api/promts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, promptId: id }),
        });
        if (!res.ok) {
          console.error('Failed to persist prompt selection');
        }
      } catch (error) {
        console.error('Failed to persist prompt selection:', error);
      }
      return;
    }

    try {
      localStorage.setItem('selectedPromptId', id);
    } catch (error) {
      console.error('Failed to store prompt selection locally:', error);
    }
  }, [userId]);

  const loadPrompts = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      const res = await fetch(`/api/promts${query}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error('Failed to fetch prompts');
      }
      const data = await res.json();

      // Ignore stale responses (e.g. default-only request finishing after authed request)
      if (seq !== requestSeqRef.current) return;

      const list: Prompt[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.prompts)
          ? data.prompts
          : [];
      setPrompts(list);

      let serverSelection: string | null = userId ? data?.selectedPromptId ?? null : null;
      let localSelection: string | null = null;
      if (!userId) {
        try {
          localSelection = localStorage.getItem('selectedPromptId');
        } catch {
          localSelection = null;
        }
      }

      const hasPrompt = (id: string | null) => Boolean(id && list.some(p => p.id === id));

      if (serverSelection && !hasPrompt(serverSelection)) {
        serverSelection = null;
      }

      if (localSelection && !hasPrompt(localSelection)) {
        localSelection = null;
      }

      let nextSelected = serverSelection ?? localSelection ?? '';
      if (!nextSelected && list.length > 0) {
        nextSelected = list[0].id;
      }

      if (nextSelected) {
        setSelectedId(nextSelected);
        const prompt = list.find(p => p.id === nextSelected);
        if (prompt && onPromptSelect) {
          try {
            await onPromptSelect(prompt.content, prompt);
          } catch (error) {
            console.error('Failed to apply prompt content:', error);
          }
        }

        const shouldPersistServer = Boolean(userId && !serverSelection);
        const shouldPersistLocal = Boolean(!userId && !localSelection);
        if ((shouldPersistServer || shouldPersistLocal) && nextSelected) {
          await persistSelection(nextSelected);
        }
      } else {
        setSelectedId('');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (seq !== requestSeqRef.current) return;
      console.error('Failed to load prompts:', error);
      // Keep last known prompts on transient failures; don't clobber UI with only default.
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoading(false);

        if (!didSignalReadyRef.current) {
          didSignalReadyRef.current = true;
          try {
            onReady?.();
          } catch {
            // ignore
          }
        }
      }
    }
  }, [userId, onPromptSelect, persistSelection, onReady]);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id);
    const prompt = prompts.find(p => p.id === id);
    if (!prompt) return;

    try {
      if (onPromptSelect) {
        await onPromptSelect(prompt.content, prompt);
      }
    } catch (error) {
      console.error('Failed to apply prompt content:', error);
    }

    try {
      await persistSelection(id);
    } catch {
      /* handled inside persistSelection */
    }
  }, [prompts, persistSelection, onPromptSelect]);

  const openNew = () => {
    if (!userId) return;
    setEditingPrompt(null);
    setTitle('');
    setContent('');
    setDialogOpen(true);
  };

  const openEdit = () => {
    if (!userId) return;
    const prompt = prompts.find(p => p.id === selectedId);
    if (!prompt || prompt.isDefault) return;
    if (prompt.ownerId && prompt.ownerId !== userId) return;
    setEditingPrompt(prompt);
    setTitle(prompt.title);
    setContent(prompt.content);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!userId) {
      toast.warning('Необходима авторизация', { description: 'Войдите, чтобы сохранять промпты.' });
      return;
    }

    if (!title.trim() || !content.trim()) return;

    if (editingPrompt) {
      await fetch('/api/promts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingPrompt.id, title, content, userId }),
      });
    } else {
      await fetch('/api/promts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, userId }),
      });
    }

    setDialogOpen(false);
    await loadPrompts();
  };

  const deletePrompt = async () => {
    if (!userId) {
      toast.warning('Необходима авторизация', { description: 'Войдите, чтобы удалять промпты.' });
      return;
    }

    const prompt = prompts.find(p => p.id === selectedId);
    if (!prompt || prompt.isDefault) return;
    if (prompt.ownerId && prompt.ownerId !== userId) return;

    toast(`Удалить промпт «${prompt.title}»?`, {
      description: 'Это действие нельзя отменить.',
      action: {
        label: 'Удалить',
        onClick: async () => {
          await fetch('/api/promts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: selectedId, userId }),
          });
          toast.success('Промпт удалён');
          await loadPrompts();
        },
      },
      cancel: { label: 'Отмена', onClick: () => {} },
    });
  };

  const selectedPrompt = prompts.find(p => p.id === selectedId);
  const canManage = Boolean(userId);
  const canModifySelected = Boolean(
    canManage &&
    selectedPrompt &&
    !selectedPrompt.isDefault &&
    (!selectedPrompt.ownerId || selectedPrompt.ownerId === userId)
  );

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Select
        value={selectedId}
        onValueChange={handleSelect}
        disabled={isLoading || prompts.length === 0}
      >
        <SelectTrigger className="flex-1 w-[550px]">
          <SelectValue placeholder="Выберите промпт..." />
        </SelectTrigger>
        <SelectContent className="flex-1 w-[550px]" position="popper"
        side="top">
          {prompts.map(p => (
            <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="outline"
        size="icon"
        onClick={openNew}
        disabled={!canManage}
      >
        <PlusIcon className="size-4" />
      </Button>

      <Button 
        variant="outline" 
        size="icon" 
        onClick={openEdit}
        disabled={!canModifySelected}
      >
        <PencilIcon className="size-4" />
      </Button>

      <Button 
        variant="outline" 
        size="icon" 
        onClick={deletePrompt}
        disabled={!canModifySelected}
      >
        <Trash2Icon className="size-4" />
      </Button>

      {dialogOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background p-6 rounded-lg w-[600px]">
            <h2 className="text-lg font-semibold mb-4">
              {editingPrompt ? 'Редактировать промпт' : 'Новый промпт'}
            </h2>
            <input
              className="w-full p-2 mb-3 border rounded"
              placeholder="Название промпта"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
            <textarea
              className="w-full p-2 mb-3 border rounded resize-none"
              rows={8}
              placeholder="Содержание промпта"
              value={content}
              onChange={e => setContent(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Отмена
              </Button>
              <Button onClick={save}>Сохранить</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}