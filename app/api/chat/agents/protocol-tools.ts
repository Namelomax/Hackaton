import type { UIMessage, UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { generateFinalDocument } from "./document-agent";
import type { AgentContext } from "./types";

export type ProtocolGenerationSink = { markdown: string };

function safeUiMessages(context: AgentContext): any[] {
  const { messages, uiMessages } = context;
  if (Array.isArray(uiMessages) && uiMessages.length > 0) return uiMessages;
  return (Array.isArray(messages) ? messages : []).map(
    (m: any, idx: number) => {
      const text = typeof m?.content === "string" ? m.content : "";
      return {
        id: String(m?.id ?? `m-${idx}-${Date.now()}`),
        role: m?.role === "assistant" ? "assistant" : "user",
        parts: [{ type: "text", text }],
        metadata: m?.metadata ?? {},
      };
    },
  );
}

/** Инструмент: полный протокол только в правую панель, не в текст чата */
export function createPublishInvestigationProtocolTool(
  writer: UIMessageStreamWriter<UIMessage>,
  context: AgentContext,
  sink: ProtocolGenerationSink,
) {
  const ui = safeUiMessages(context);

  return tool({
    description: `Сформировать полный протокол обследования в документе приложения (правая панель): события data-title, data-documentDelta, DOCX. Вызывай ТОЛЬКО когда пользователь явно просит создать/сформировать протокол или вывести его в документ (например «сделай протокол», «сформируй документ», «всё верно — делай протокол», «в правую панель»). НЕ вызывай при приветствии, только загрузке файла без такой просьбы или при обычном ответе на уточняющий вопрос. Не дублируй десять разделов протокола в тексте сообщения — только через этот инструмент.`,
    inputSchema: z.object({
      reasonBrief: z
        .string()
        .max(500)
        .describe(
          "Одно короткое предложение: что именно пользователь сказал/написал, из чего следует, что нужна генерация документа.",
        ),
    }),
    execute: async ({ reasonBrief }) => {
      const md = await generateFinalDocument(
        ui,
        context.userPrompt,
        writer,
        context.model,
        context.documentContent,
        context.conversationId ?? null,
      );
      sink.markdown = md;
      return {
        ok: true as const,
        reasonBrief,
        message:
          "Протокол обследования сформирован и отправлен в правую панель документа.",
      };
    },
  });
}
