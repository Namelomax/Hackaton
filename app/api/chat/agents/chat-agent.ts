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
Пользователь уже прикрепил файл или ведёт диалог (либо включён RAG-индекс с загруженной расшифровкой). НИКОГДА не начинай ответ с «Здравствуйте», «Привет», «Я AI-ассистент» или любого вводного абзаца о том, кто ты. Любая фраза вроде «Рад помочь», «Я помогу вам», «Пришлите расшифровку» или «Давайте начнём» в начале ответа — ЗАПРЕЩЕНА.
════════════════════════════════════════════
 ПРОПУСТИ ЭТАП 1 (приветствие)!
 Расшифровка встречи уже доступна — либо прикреплена к сообщению, либо проиндексирована в RAG.
 НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации).

 ЕСЛИ ПОЛЬЗОВАТЕЛЬ САМ УКАЗАЛ номер протокола и/или дату встречи (например «номер протокола 1, дата 05.04.2026»):
 → Примите эти значения для раздела 1 БЕЗ проверки «есть ли в расшифровке» и БЕЗ вопроса «подтверждаете ли верно».
 → Сразу переходите к разделу 2: вызовите retrieveFromIndexedDocuments про повестку/темы и задайте ОДИН вопрос по повестке.

 ЕСЛИ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ ПУСТОЕ ИЛИ СОДЕРЖИТ ТОЛЬКО ФАЙЛ БЕЗ ТЕКСТА (номер/дату не назвал):
 → Вызови retrieveFromIndexedDocuments с вопросом «какой номер протокола, дата и название встречи упоминались в расшифровке?» для раздела 1.
 → Предложи найденное из excerpts; если в excerpts пусто — спроси номер и дату у пользователя (не «подтвердите то, что вы сами написали»).
 → НЕ проси пользователя «прислать расшифровку» — она уже есть.

 ЕСЛИ ПОЛЬЗОВАТЕЛЬ НАПИСАЛ КОРОТКОЕ СЛОВО («Привет», «Начинаем», «Привет, начнём»):
 → Это сигнал начать работу. Сразу переходи к первому уточняющему вопросу по расшифровке.

 Задавай СТРОГО ОДИН уточняющий вопрос за ответ — никаких списков, никаких «необходимо уточнить следующее:». Если хочется спросить несколько вещей — выбери САМУЮ важную и спроси только её.
 В ЭТОМ ЧАТЕ ЗАПРЕЩЕНО выводить полный протокол из 10 разделов — используй инструмент publishInvestigationProtocol.
 ЗАПРЕЩЕНЫ заголовки как у финального документа: «Протокол встречи», блоки с разделами 1–10 подряд — пользователь увидит это в правой панели.
 Пиши название компании «Форус», по продукту — только «протокол обследования».
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
    hasAttachedFiles(messages) ||
    hasAttachedFiles(context.uiMessages ?? []) ||
    Boolean(ragRetrievalEnabled);
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
      conversationId,
    });

  const msgCount = messagesWithUserPrompt.length;
  const estimatedChars = messagesWithUserPrompt.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
    0
  );
  // Рус. текст ≈ 2.34 симв/токен (не 4 как для EN). Уточнённая оценка.
  console.log(`🤖 streamText start: msgs=${msgCount} ~chars=${estimatedChars} (~${Math.round(estimatedChars / 2.3)} tokens) rag=${ragRetrievalEnabled}`);
  const agentStartMs = Date.now();

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
        // Qwen3 non-thinking: temperature=0.7, topP=0.8, topK=20 (официальные рекомендации HuggingFace).
        // presencePenalty=1.5 подавляет повторения в квантованных моделях.
        temperature: 0.7,
        topP: 0.8,
        topK: 20,
        presencePenalty: 1.5,
        messages: messagesWithUserPrompt,
        system: adaptedSystemPrompt,
        tools,
        stopWhen: stepCountIs(ragRetrievalEnabled ? 14 : 8),
        ...(abortSignal ? { abortSignal } : {}),
        onStepFinish: ({ usage, finishReason, toolCalls }) => {
          const tools = toolCalls?.map((t: any) => t.toolName).join(', ') || 'none';
          console.log(`  ↳ step done: reason=${finishReason} tools=[${tools}] tokens=${usage?.totalTokens ?? '?'}`);
        },
      });

      writer.merge(result.toUIMessageStream());
      await result.usage;
    },
    onFinish: async ({ messages: finished }) => {
      const elapsed = Date.now() - agentStartMs;
      console.log(`✅ agent done: ${elapsed}ms total, protocol=${sink.markdown.length > 0 ? sink.markdown.length + ' chars' : 'none'}`);
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
