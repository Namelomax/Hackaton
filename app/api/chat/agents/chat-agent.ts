import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  type ModelMessage,
} from "ai";
import type { AgentContext } from "./types";
import { updateConversation, saveConversation } from "@/lib/getPromt";
import {
  createPublishInvestigationProtocolTool,
  type ProtocolGenerationSink,
} from "./protocol-tools";
import { createRetrieveFromIndexedDocumentsTool } from "./rag-tools";

const PROTOCOL_TOOL_SYSTEM_APPENDIX = `

## Инструмент publishInvestigationProtocol
- Это **единственный** поддерживаемый способ вывести полный протокол обследования (все разделы) в документ **справа**.
- В тексте ответа пользователю **не** воспроизводи десять разделов протокола — после успешного вызова инструмента достаточно одной короткой фразы («Готово, протокол в панели справа»).
- Вызывай инструмент **только** при явной просьбе оформить/сгенерировать протокол или документ; при сборе фактов и уточнений отвечай обычным текстом без инструмента.
`;

function hasAttachedFiles(messages: any[]): boolean {
  const HIDDEN = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;
  for (const msg of messages || []) {
    if (Array.isArray(msg?.parts) && msg.parts.some((p: any) => p?.type === "file")) {
      return true;
    }
    if (typeof msg?.content === "string") {
      const c = msg.content;
      if (
        c.includes("AI-HIDDEN") ||
        c.includes("Вложенный файл") ||
        c.includes("[RAG]") ||
        c.includes("[Вложение «")
      ) {
        return true;
      }
      const visible = c.replace(HIDDEN, "").trim();
      if (msg?.role === "user" && visible.length >= 400) {
        return true;
      }
    }
    if (Array.isArray(msg?.parts)) {
      const textParts = msg.parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n");
      const vis = String(textParts || "")
        .replace(HIDDEN, "")
        .trim();
      if (msg?.role === "user" && vis.length >= 400) {
        return true;
      }
    }
  }
  return false;
}

function adaptSystemPrompt(
  systemPrompt: string,
  hasFiles: boolean,
  messageCount: number,
): string {
  if (
    (hasFiles || messageCount > 1) &&
    !systemPrompt.includes("АДАПТАЦИЯ: Расшифровка получена")
  ) {
    const adaptation = `АДАПТАЦИЯ: Расшифровка получена
════════════════════════════════════════════
⚡ ПРОПУСТИ ЭТАП 1 (приветствие)!
⚡ Ты уже имеешь расшифровку встречи.
⚡ НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации): задавай ОДИН уточняющий вопрос за ответ (или одно короткое подтверждение без таблиц).
⚡ Начни с самого важного пропуска (часто — участники, дата, номер протокола), а не с выгрузки всего документа.
⚡ НЕ показывай приветствие "Привет! Я AI-агент..."
⚡ В ЭТОМ ЧАТЕ ЗАПРЕЩЕНО выводить полный протокол из 10 разделов, все таблицы и весь текст «как в документе» за один ответ — используй инструмент publishInvestigationProtocol.
⚡ ЗАПРЕЩЕНЫ заголовки как у финального документа: «Протокол встречи», «Номер протокола:», блоки с разделами 1–10 подряд — пользователь увидит это в правой панели после вызова инструмента.
⚡ Если текст пользователя уже похож на протокол — не переписывай его целиком; продолжай уточнять по одному пункту.
⚡ Пиши название компании «Форус». по продукту — только «протокол обследования».
⚡ Полный протокол формируется только вызовом инструмента publishInvestigationProtocol (правая панель).
════════════════════════════════════════════

`;
    return adaptation + systemPrompt;
  }
  return systemPrompt;
}

function buildFixIssuesPrompt(
  existingDocument: string,
  issuesText: string,
): string {
  return `ТЫ — редактор деловых документов. Твоя задача — исправить документ по замечаниям.

ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА:
\`\`\`
${existingDocument}
\`\`\`

ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:
${issuesText}

════════════════════════════════════════════
ИНСТРУКЦИЯ ПО ИСПРАВЛЕНИЮ:
════════════════════════════════════════════

1. ВНИМАТЕЛЬНО прочитай каждое замечание
2. Найди в документе место, к которому относится замечание
3. ИСПРАВЬ ошибку согласно предложению
4. СОХРАНИ структуру документа (все 10 разделов протокола)
5. НЕ удаляй существующую информацию, только исправляй ошибки
6. Если замечание касается формата (таблицы, списки) — исправь форматирование
7. Если замечание касается содержания — добавь/исправь информацию
8. После всех исправлений — покажи ИСПРАВЛЕННУЮ ВЕРСИЮ всего документа в формате Markdown.

════════════════════════════════════════════
ФОРМАТ ОТВЕТА:
════════════════════════════════════════════

Сначала кратко перечисли, какие замечания ты исправил:
"Исправлены следующие замечания:
1. [замечание 1] — исправлено
2. [замечание 2] — исправлено
..."

Затем покажи ПОЛНУЮ исправленную версию документа в формате Markdown.

════════════════════════════════════════════
ВАЖНО:
════════════════════════════════════════════

- Не игнорируй ни одно замечание
- Если замечание непонятно — спроси уточнение
- Если исправление требует дополнительной информации — запроси её
- Сохраняй деловой стиль документа`;
}

function safeOriginalUIMessages(context: AgentContext): any[] {
  const { messages, uiMessages } = context;
  if (Array.isArray(uiMessages) && uiMessages.length > 0)
    return uiMessages as any[];
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

export async function runChatAgent(
  context: AgentContext,
  systemPrompt: string,
  userPrompt: string,
) {
  const {
    messages,
    model,
    userId,
    conversationId,
    documentContent,
    abortSignal,
    ragRetrievalEnabled,
    ragMode,
  } = context;
  const messagesWithUserPrompt: ModelMessage[] = [];

  if (userPrompt && userPrompt.trim()) {
    messagesWithUserPrompt.push({
      role: "system",
      content: userPrompt,
    });
  }

  const lastUserMessage = messages[messages.length - 1];
  let lastUserText = "";

  if (lastUserMessage) {
    const msg = lastUserMessage as any;
    if (typeof msg.content === "string") {
      lastUserText = msg.content;
    } else if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find(
        (p: any) => p?.type === "text" && typeof p.text === "string",
      );
      lastUserText = textPart?.text || "";
    }
  }

  const hasFixRequest =
    lastUserText.includes("исправь") &&
    (lastUserText.includes("замечан") ||
      lastUserText.includes("ошибк") ||
      lastUserText.includes("предлож"));

  if (hasFixRequest && documentContent && documentContent.trim()) {
    const issuesMatch = lastUserText.match(
      /ЗАМЕЧАНИЯ, КОТОРЫЕ НУЖНО ИСПРАВИТЬ:([\s\S]*)/i,
    );
    const issuesText = issuesMatch ? issuesMatch[1] : lastUserText;

    const fixPrompt = buildFixIssuesPrompt(documentContent, issuesText);
    messagesWithUserPrompt.push({
      role: "system",
      content: fixPrompt,
    });

    messagesWithUserPrompt.push(lastUserMessage);

    const adaptedSystemPrompt = adaptSystemPrompt(
      systemPrompt,
      hasAttachedFiles(messages) || hasAttachedFiles(context.uiMessages ?? []),
      messages.length,
    );

    const ragTool =
      ragRetrievalEnabled &&
      createRetrieveFromIndexedDocumentsTool({
        model,
        messages: messagesWithUserPrompt,
        ragMode: ragMode ?? "hybrid",
        abortSignal,
      });

    const stream = streamText({
      model,
      temperature: 0,
      messages: messagesWithUserPrompt,
      system: adaptedSystemPrompt,
      ...(ragTool ? { tools: { retrieveFromIndexedDocuments: ragTool } } : {}),
      ...(ragTool ? { stopWhen: stepCountIs(12) } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });

    return stream.toUIMessageStreamResponse({
      onFinish: async ({ messages: finished }) => {
        if (userId) {
          try {
            if (conversationId) {
              await updateConversation(conversationId, finished);
            } else {
              await saveConversation(userId, finished);
            }
          } catch (e) {
            console.error("chat persistence failed", e);
          }
        }
      },
    });
  }

  if (documentContent && documentContent.trim()) {
    messagesWithUserPrompt.push({
      role: "system",
      content: `ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА (пользователь редактировал вручную):\n\n${documentContent}\n\nИспользуй эту версию как основу для дальнейшей работы. Если пользователь вносит изменения в документ, сохраняй их и учитывай в следующих ответах.`,
    });
  }

  messagesWithUserPrompt.push(...(messages as ModelMessage[]));

  const hasFiles =
    hasAttachedFiles(messages) || hasAttachedFiles(context.uiMessages ?? []);
  const adaptedSystemPrompt =
    adaptSystemPrompt(systemPrompt, hasFiles, messages.length) +
    PROTOCOL_TOOL_SYSTEM_APPENDIX;

  const sink: ProtocolGenerationSink = { markdown: "" };

  const retrieveFromIndexedDocumentsTool =
    ragRetrievalEnabled &&
    createRetrieveFromIndexedDocumentsTool({
      model,
      messages: messagesWithUserPrompt,
      ragMode: ragMode ?? "hybrid",
      abortSignal,
    });

  const stream = createUIMessageStream({
    originalMessages: safeOriginalUIMessages(context),
    execute: async ({ writer }) => {
      const publishInvestigationProtocol =
        createPublishInvestigationProtocolTool(writer, context, sink);

      const tools = {
        publishInvestigationProtocol,
        ...(retrieveFromIndexedDocumentsTool
          ? { retrieveFromIndexedDocuments: retrieveFromIndexedDocumentsTool }
          : {}),
      };

      const result = streamText({
        model,
        temperature: 0,
        messages: messagesWithUserPrompt,
        system: adaptedSystemPrompt,
        tools,
        stopWhen: stepCountIs(ragRetrievalEnabled ? 14 : 8),
        ...(abortSignal ? { abortSignal } : {}),
      });

      writer.merge(result.toUIMessageStream());
      await result.usage;
    },
    onFinish: async ({ messages: finished }) => {
      if (!userId) return;
      try {
        const doc =
          typeof sink.markdown === "string" && sink.markdown.trim().length > 0
            ? sink.markdown
            : undefined;
        if (conversationId) {
          await updateConversation(conversationId, finished, doc);
        } else {
          await saveConversation(userId, finished, doc);
        }
      } catch (e) {
        console.error("chat persistence failed", e);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
