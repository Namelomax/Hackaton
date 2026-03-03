import { ModelMessage} from 'ai';

export interface AgentContext {
  messages: ModelMessage[];
  // Optional: original UI messages (with `parts`) used by UI-stream helpers.
  // When missing, agents should derive a minimal UI representation from `messages`.
  uiMessages?: any[];
  userPrompt: string | null;
  userId?: string | null;
  conversationId?: string | null;
  documentContent?: string; // State Injection
  model: any; // The language model instance
  retryCount?: number;  
}

export interface AgentResponse {
  stream: ReadableStream;
}
