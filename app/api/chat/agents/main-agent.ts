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

  console.log("🧭 Main agent: chat stream + publishInvestigationProtocol tool");
  return runChatAgent(context, systemPrompt, userPrompt);
}
