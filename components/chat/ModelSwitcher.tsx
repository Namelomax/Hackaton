'use client';

import { useState } from 'react';
import { DEFAULT_LOCAL_CHAT_MODELS, LOCAL_MODEL_LABELS } from '@/lib/chat-models';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ModelSwitcherProps = {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
};

export function ModelSwitcher({ value, onChange, disabled = false }: ModelSwitcherProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 font-medium">Модель:</label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-auto min-w-[140px] h-9 text-sm">
          <SelectValue placeholder="Выберите модель" />
        </SelectTrigger>
        <SelectContent align="end" className="min-w-[180px]">
          {DEFAULT_LOCAL_CHAT_MODELS.map((model) => (
            <SelectItem key={model} value={model} className="text-sm">
              {LOCAL_MODEL_LABELS[model] || model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
