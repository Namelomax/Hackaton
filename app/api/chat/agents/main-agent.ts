import type { AgentContext } from "./types";
import {
  explicitDocumentGenerationRequest,
  getLastUserPlainText,
} from "./orchestrator";
import { runChatAgent } from "./chat-agent";
import { runDocumentAgent } from "./document-agent";
import { classifyIntent } from "./classifier";

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

  // Всё остальное решает модель, а не список условий.
  //
  // Раньше здесь стояла жёсткая ветка «есть inline-расшифровка и нет ответа
  // ассистента → документ». Она не работала для расшифровки, ВСТАВЛЕННОЙ
  // ТЕКСТОМ: hasInlineTranscript считается только от вложений и блоков
  // <AI-HIDDEN>, а вставленный текст туда не попадает. Плюс любое такое
  // условие приходится дописывать под каждый новый случай.
  //
  // Классификатор видит текст последнего сообщения и факт вложения, а что с
  // этим делать — описано в SGR_CLASSIFIER_PROMPT. Способ передачи
  // расшифровки перестал иметь значение.
  try {
    const intent = await classifyIntent(context);
    if (intent === 'document') {
      console.log('🧭 Main agent: классификатор → document pipeline');
      return runDocumentAgent(context);
    }
  } catch (e) {
    // Классификатор недоступен — не повод ронять запрос: продолжаем диалогом,
    // а явная просьба сформировать протокол отработает быстрым путём выше.
    console.warn('🧭 Main agent: классификатор не отработал → chat:', (e as Error)?.message);
  }

  console.log("🧭 Main agent: chat stream + publishInvestigationProtocol tool");
  return runChatAgent(context, systemPrompt, userPrompt);
}
