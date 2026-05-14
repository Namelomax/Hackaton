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

## Инструмент publishInvestigationProtocol — единственный путь записи в правую панель
- Любое изменение/создание протокола обследования (создание с нуля, исправление по замечаниям, обновление после уточнений) попадает к пользователю **только через вызов этого инструмента**. Текст протокола в чате правую панель НЕ обновляет.
- Триггеры на вызов: «сформируй/сделай/собери протокол», «оформи документ», «выведи в документ», «обнови протокол/документ», «исправь замечания», «переделай протокол», «всё верно, делай», «в правую панель».
- НЕ вызывай при: приветствии, простом подтверждении получения файла, одиночном уточняющем вопросе, обсуждении того «что писать» без явной команды записать.
- После успешного вызова в чат пиши коротко (1–3 строки): что сделано/исправлено и фразу «обновлено в правой панели». Не дублируй текст протокола в чат.
- Если данных не хватает для качественного протокола — НЕ вызывай инструмент, задай **один** короткий уточняющий вопрос.
`;

function hasAttachedFiles(messages: any[]): boolean {
  const HIDDEN = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;
  for (const msg of messages || []) {
    // 1. UIMessage: явные file-части
    if (Array.isArray(msg?.parts) && msg.parts.some((p: any) => p?.type === "file")) {
      return true;
    }
    // 2. Нормализованное UIMessage из route.ts: файлы переехали в metadata.attachments,
    //    а parts стали [{type:'text', text: combined}] — нужно смотреть в metadata.
    if (
      msg?.role === "user" &&
      Array.isArray(msg?.metadata?.attachments) &&
      msg.metadata.attachments.length > 0
    ) {
      return true;
    }
    // 3. Строковый content (обогащённый messagesWithHidden или прямой UIMessage)
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
    // 4. ModelMessage после convertToModelMessages: content — массив частей
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content as any[]) {
        if (part?.type === "file") return true;
        if (part?.type === "text" && typeof part.text === "string") {
          const t = part.text;
          if (t.includes("Вложенный файл") || t.includes("[Вложение «")) return true;
        }
      }
    }
    // 5. text-parts длинного сообщения (UIMessage)
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
КРИТИЧЕСКИ ВАЖНО — ЗАПРЕТ НА ПРИВЕТСТВИЕ:
Пользователь уже прикрепил файл или ведёт диалог. НИКОГДА не начинай ответ с «Здравствуйте», «Привет», «Я AI-ассистент» или любого вводного абзаца о том, кто ты. Любая фраза вроде «Рад помочь», «Я помогу вам» или «Давайте начнём» в начале ответа — ЗАПРЕЩЕНА.
════════════════════════════════════════════
 ПРОПУСТИ ЭТАП 1 (приветствие)!
 Ты уже имеешь расшифровку встречи (или её фрагмент через RAG).
 НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации): задавай ОДИН уточняющий вопрос за ответ (или одно короткое подтверждение без таблиц).
 Начни с самого важного пропуска (часто — участники, дата, номер протокола), а не с выгрузки всего документа.
 Если пользователь написал только «Привет» или другое короткое слово — это сигнал что он хочет начать работу с файлом. Немедленно задай первый уточняющий вопрос по содержимому файла, не объясняй что ты умеешь делать.
 В ЭТОМ ЧАТЕ ЗАПРЕЩЕНО выводить полный протокол из 10 разделов, все таблицы и весь текст «как в документе» за один ответ — используй инструмент publishInvestigationProtocol.
 ЗАПРЕЩЕНЫ заголовки как у финального документа: «Протокол встречи», «Номер протокола:», блоки с разделами 1–10 подряд — пользователь увидит это в правой панели после вызова инструмента.
 Если текст пользователя уже похож на протокол — не переписывай его целиком; продолжай уточнять по одному пункту.
 Пиши название компании «Форус», по продукту — только «протокол обследования».
 Полный протокол формируется только вызовом инструмента publishInvestigationProtocol (правая панель).
════════════════════════════════════════════

`;
    return adaptation + systemPrompt;
  }
  return systemPrompt;
}

function buildFixIssuesSystemAppendix(
  existingDocument: string,
  issuesText: string,
): string {
  return `

## Правка протокола по замечаниям (правая панель)
Пользователь дал замечания к уже сформированному протоколу обследования. Текущая версия документа из правой панели — ниже.

ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА:
"""
${existingDocument}
"""

ЗАМЕЧАНИЯ:
${issuesText}

Алгоритм:
1. Сохрани все 10 разделов протокола; ничего ценного не удаляй.
2. Для каждого замечания внеси конкретную правку в нужный раздел.
3. Если в данных пробел и нельзя исправить без уточнения — задай **один** короткий уточняющий вопрос обычным текстом, инструмент не вызывай.
4. Когда правки очевидны (или после уточнения у пользователя) — **обязательно** вызови инструмент **publishInvestigationProtocol**, чтобы обновлённый протокол попал в правую панель.
5. В сообщении чата дай короткое резюме (1–3 строки: «Исправлено: …»), а сам полный текст протокола в чате не дублируй — он появится в правой панели.`;
}

function detectFixRequest(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  if (t.includes("замечан") || t.includes("исправь") || t.includes("исправить")) return true;
  if (t.includes("обнови") && (t.includes("документ") || t.includes("протокол"))) return true;
  if (t.includes("переделай") && (t.includes("документ") || t.includes("протокол"))) return true;
  return false;
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

  const hasDocument = Boolean(documentContent && documentContent.trim());
  const hasFixRequest = hasDocument && detectFixRequest(lastUserText);

  if (hasDocument) {
    messagesWithUserPrompt.push({
      role: "system",
      content: `ТЕКУЩАЯ ВЕРСИЯ ДОКУМЕНТА (правая панель):\n\n${documentContent}\n\nИспользуй эту версию как основу для дальнейшей работы. Если пользователь вносит изменения, обновляй её через инструмент publishInvestigationProtocol, не пересылай полный текст протокола в чат.`,
    });
  }

  messagesWithUserPrompt.push(...(messages as ModelMessage[]));

  const hasFiles =
    hasAttachedFiles(messages) || hasAttachedFiles(context.uiMessages ?? []);
  let adaptedSystemPrompt =
    adaptSystemPrompt(systemPrompt, hasFiles, messages.length) +
    PROTOCOL_TOOL_SYSTEM_APPENDIX;
  if (hasFixRequest) {
    const issuesMatch = lastUserText.match(
      /ЗАМЕЧАНИЯ[,:][\s\S]*$|замечания[,:][\s\S]*$/i,
    );
    const issuesText = issuesMatch ? issuesMatch[0] : lastUserText;
    adaptedSystemPrompt += buildFixIssuesSystemAppendix(documentContent || "", issuesText);
  }

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
