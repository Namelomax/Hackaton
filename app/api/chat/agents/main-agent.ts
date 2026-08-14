import type { AgentContext } from "./types";
import {
  explicitDocumentGenerationRequest,
  getLastUserPlainText,
} from "./orchestrator";
import { runChatAgent } from "./chat-agent";
import { runDocumentAgent } from "./document-agent";

export async function runMainAgent(
  context: AgentContext,
  systemPrompt: string,
  userPrompt: string,
) {
  const lastUser = getLastUserPlainText(context);

  if (explicitDocumentGenerationRequest(lastUser)) {
    console.log("🧭 Main agent: explicit protocol request → document pipeline");
    return runDocumentAgent(context);
  }

  // Автоматическая генерация при первой загрузке расшифровки:
  // если ещё нет ни одного ответа ассистента — пропускаем диалог и сразу
  // строим протокол. Последующие сообщения (правки) идут через чат-агент.
  if (context.hasInlineTranscript) {
    const uiMsgs: any[] = Array.isArray((context as any).uiMessages)
      ? (context as any).uiMessages
      : [];
    const hasAssistantReply = uiMsgs.some((m: any) => m?.role === 'assistant');
    if (!hasAssistantReply) {
      console.log("🧭 Main agent: расшифровка загружена впервые → document pipeline (авто)");
      return runDocumentAgent(context);
    }
  }

  console.log("🧭 Main agent: chat stream + publishInvestigationProtocol tool");
  return runChatAgent(context, systemPrompt, userPrompt);
}
