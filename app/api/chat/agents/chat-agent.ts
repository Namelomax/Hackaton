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
import { PROTOCOL_TIMECODE_ADAPTATION_LINE } from "@/lib/protocol-timecodes";
import { createRetrieveFromIndexedDocumentsTool } from "./rag-tools";
import {
  ollamaStreamHeartbeatMs,
  pickChatMaxOutputTokens,
} from "@/lib/ollama-limits";
import { PROTOCOL_REGULATION } from "@/lib/prompts/regulation";

const PROTOCOL_TOOL_SYSTEM_APPENDIX = `

## Цитаты из протокола
Когда сообщение пользователя начинается с "[Цитата из протокола]: «...»", это означает:
- Пользователь выделил конкретный фрагмент из документа в правой панели и хочет его исправить или уточнить
- Найди этот фрагмент в ТЕКУЩЕЙ ВЕРСИИ ДОКУМЕНТА и внеси изменение именно там
- После правки — обновить документ через publishInvestigationProtocol
- Если смысл правки неочевиден — задай один уточняющий вопрос, не трогая документ

## Инструмент publishInvestigationProtocol — единственный путь записи в правую панель
- Любое изменение/создание протокола обследования (создание с нуля, исправление по замечаниям, обновление после уточнений) попадает к пользователю **только через вызов этого инструмента**. Текст протокола в чате правую панель НЕ обновляет.
- Триггеры на вызов: «сформируй/сделай/собери протокол», «оформи документ», «выведи в документ», «обнови протокол/документ», «исправь замечания», «переделай протокол», «всё верно, делай», «в правую панель».
- **АВТОГЕНЕРАЦИЯ — только после явного подтверждения раздела 5:** Вызывай publishInvestigationProtocol автоматически ТОЛЬКО если выполнены ВСЕ три условия: (а) пользователь ранее назвал номер и тему договора И (б) ты уже предложил пользователю раздел 5 («Согласовано») с конкретными именами подписантов И (в) пользователь ответил «Верно»/«да»/«подтверждаю» ИМЕННО на вопрос про раздел 5. Ответы вида «Все фио правильные», «хорошо», подтверждение ФИО или договора — НЕ являются триггером генерации.
- **ЗАПРЕТ автогенерации без данных о договоре:** Если в истории диалога пользователь ни разу не называл номер договора и тему договора — НЕ вызывай publishInvestigationProtocol. Сначала задай вопрос: «Уточните, пожалуйста: 1. Номер и дата договора. 2. Тема договора.»
- **ЗАПРЕТ автогенерации без подтверждения раздела 4:** Если пользователь ещё не подтвердил содержание встречи (Слушали / Обсудили / Решили по каждому пункту повестки) — НЕ вызывай publishInvestigationProtocol. Сначала предложи раздел 4 на подтверждение.
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
  options: { ragRetrievalEnabled: boolean; hasInlineTranscript: boolean },
): string {
  if (
    (hasFiles || messageCount > 1) &&
    !systemPrompt.includes("АДАПТАЦИЯ: Расшифровка получена")
  ) {
    const useRagTool =
      options.ragRetrievalEnabled && !options.hasInlineTranscript;
    const section1FromTranscript = useRagTool
      ? `→ Вызови retrieveFromIndexedDocuments с вопросом «какой номер протокола, дата и название встречи упоминались в расшифровке?» для раздела 1.
 → Предложи найденное из excerpts; если excerpts пусты — спроси номер и дату у пользователя.`
      : `→ Найди в блоке «ВЛОЖЕНИЯ ПОЛЬЗОВАТЕЛЯ» (полный текст расшифровки) номер протокола, дату и название встречи для раздела 1.
 → Предложи найденное; если в тексте нет — спроси номер и дату у пользователя. **Не вызывай** retrieveFromIndexedDocuments — расшифровка уже в системном контексте.`;
    const section2AfterUserFacts = useRagTool
      ? `→ Сразу переходите к разделу 2: вызовите retrieveFromIndexedDocuments про повестку/темы и задайте ОДИН вопрос по повестке.`
      : `→ Сразу переходите к разделу 2: опирайтесь на текст расшифровки в «ВЛОЖЕНИЯ»; задайте ОДИН вопрос по повестке.`;

    const adaptation = `АДАПТАЦИЯ: Расшифровка получена
ОДИН РАЗДЕЛ ПРОТОКОЛА ЗА ОДНО СООБЩЕНИЕ:
Не объединяй в одном ответе разделы 4–5 или любые два номера раздела подряд. После «Верно» пользователя — в следующем сообщении только следующий раздел.
ИСКЛЮЧЕНИЕ ДЛЯ РАЗДЕЛА 5: раздел 5 (Согласовано) заполняй из уже известных участников (раздел 3) и предлагай готовый вариант — не задавай пустых вопросов. После подтверждения пользователя («Верно» / «да») — **немедленно вызывай publishInvestigationProtocol**.
⚠️ ДОГОВОР — ОБЯЗАТЕЛЬНОЕ ПОЛЕ: В конце первого черновика ВСЕГДА спрашивай номер, дату и тему договора. Без ответа пользователя на этот вопрос — publishInvestigationProtocol НЕ вызывать.

ТАЙМ-КОДЫ: ${PROTOCOL_TIMECODE_ADAPTATION_LINE} Пример: строка «00:02:47 — … Никита Касьянов, представитель Форус» → «…Форус [ТС: 00:02:47].» Таблица участников — [ТС: …] в каждой ячейке с фактом. Без [ТС: …] в ответе по расшифровке — недопустимо.
════════════════════════════════════════════
 ПРОПУСТИ ЭТАП 1 (приветствие)!
 Расшифровка встречи уже доступна — в системном блоке «ВЛОЖЕНИЯ»${useRagTool ? " и/или в RAG-индексе" : ""}.
 НЕМЕДЛЕННО ПЕРЕХОДИ К ЭТАПУ 2 (сбор информации).

 ЕСЛИ ПОЛЬЗОВАТЕЛЬ САМ УКАЗАЛ номер протокола и/или дату встречи (например «номер протокола 1, дата 05.04.2026»):
 → Примите эти значения для раздела 1 БЕЗ проверки «есть ли в расшифровке» и БЕЗ вопроса «подтверждаете ли верно».
 ${section2AfterUserFacts}

 ЕСЛИ СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ ПУСТОЕ ИЛИ СОДЕРЖИТ ТОЛЬКО ФАЙЛ БЕЗ ТЕКСТА (номер/дату не назвал):
 ${section1FromTranscript}
 → НЕ проси пользователя «прислать расшифровку» — она уже есть.

 ЕСЛИ ПОЛЬЗОВАТЕЛЬ НАПИСАЛ КОРОТКОЕ СЛОВО («Привет», «Начинаем», «Привет, начнём») ПОСЛЕ того как файл уже был:
 → Не повторяй приветствие. Сразу первый уточняющий вопрос по расшифровке (раздел 1).

 Задавай СТРОГО ОДИН уточняющий вопрос за ответ — никаких списков, никаких «необходимо уточнить следующее:». Если хочется спросить несколько вещей — выбери САМУЮ важную и спроси только её.
 ПЕРВЫЙ ОТВЕТ после файла: предложи шапку (дата, №, тема), таблицы участников и повестку. Закончи обязательным блоком: «Подтвердите повестку + уточните номер, дату и тему договора». НЕ включай раздел 4 (Слушали/Обсудили/Решили) — он пишется ТОЛЬКО после того как пользователь подтвердил повестку.
 В ЭТОМ ЧАТЕ ЗАПРЕЩЕНО выводить полный протокол из 5 разделов — используй инструмент publishInvestigationProtocol.
 ЗАПРЕЩЕНЫ заголовки как у финального документа: «Протокол встречи», блоки с разделами 1–5 подряд — пользователь увидит это в правой панели.
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
1. Сохрани все 5 разделов протокола; ничего ценного не удаляй.
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
    hasInlineTranscript,
    useThinking,
    ragMode,
  } = context;
  const messagesWithUserPrompt: ModelMessage[] = [];

  if (userPrompt && userPrompt.trim()) {
    messagesWithUserPrompt.push({
      role: "system",
      content: userPrompt,
    });
  }

  messagesWithUserPrompt.push({
    role: "system",
    content: PROTOCOL_REGULATION,
  });

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
  const inlineTranscript = Boolean(hasInlineTranscript);
  let adaptedSystemPrompt =
    adaptSystemPrompt(systemPrompt, hasFiles, messages.length, {
      ragRetrievalEnabled: Boolean(ragRetrievalEnabled),
      hasInlineTranscript: inlineTranscript,
    }) + PROTOCOL_TOOL_SYSTEM_APPENDIX;
  if (!useThinking && !adaptedSystemPrompt.startsWith("/no_think")) {
    adaptedSystemPrompt = "/no_think\n\n" + adaptedSystemPrompt;
  }
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
  const dialogMessageCount = messages.length;
  const messagesChars = messagesWithUserPrompt.reduce(
    (sum, m) =>
      sum +
      (typeof m.content === "string"
        ? m.content.length
        : JSON.stringify(m.content).length),
    0
  );
  const systemChars = adaptedSystemPrompt.length;
  const estimatedInputTokens = Math.round(
    (messagesChars + systemChars) / 2.34,
  );
  const maxOutputTokens = pickChatMaxOutputTokens({
    hasInlineTranscript: inlineTranscript,
    dialogMessageCount,
  });
  console.log(
    `🤖 streamText start: msgs=${msgCount} dialog=${dialogMessageCount} input≈${estimatedInputTokens}tok (sys=${systemChars}c) maxOut=${maxOutputTokens} rag=${Boolean(ragRetrievalEnabled)} inlineDoc=${inlineTranscript}`,
  );
  const agentStartMs = Date.now();
  const heartbeatMs = ollamaStreamHeartbeatMs(inlineTranscript);
  let lastHeartbeatAt = agentStartMs;
  let streamedTextChars = 0;
  let streamedReasoningChars = 0;
  let streamPhase: "prefill" | "generating" = "prefill";

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

      let continueMessages: ModelMessage[] = messagesWithUserPrompt;
      const MAX_CONTINUATIONS = 2;

      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        const result = streamText({
          model,
          // Qwen3 non-thinking: temperature=0.7, topP=0.8, topK=20 (официальные рекомендации HuggingFace).
          // presencePenalty=1.5 подавляет повторения в квантованных моделях.
          temperature: 0.7,
          topP: 0.8,
          presencePenalty: 1.5,
          maxOutputTokens,
          messages: continueMessages,
          system: adaptedSystemPrompt,
          tools,
          stopWhen: stepCountIs(ragRetrievalEnabled ? 14 : 8),
          ...(abortSignal ? { abortSignal } : {}),
          onChunk: ({ chunk }) => {
            if (chunk.type === "text-delta" && "text" in chunk && chunk.text) {
              streamedTextChars += chunk.text.length;
              streamPhase = "generating";
            }
            if (chunk.type === "reasoning-delta" && "text" in chunk && chunk.text) {
              streamedReasoningChars += chunk.text.length;
              streamPhase = "generating";
            }
            const now = Date.now();
            if (now - lastHeartbeatAt >= heartbeatMs) {
              lastHeartbeatAt = now;
              console.log(
                `  ⏳ stream: ${Math.round((now - agentStartMs) / 1000)}s phase=${streamPhase} out≈${streamedTextChars} think≈${streamedReasoningChars}`,
              );
            }
          },
          onStepFinish: ({ usage, finishReason, toolCalls, text }) => {
            const toolNames = toolCalls?.map((t: any) => t.toolName).join(', ') || 'none';
            const outChars = typeof text === 'string' ? text.length : streamedTextChars;
            console.log(
              `  ↳ step done (attempt ${attempt}): reason=${finishReason} tools=[${toolNames}] tokens=${usage?.totalTokens ?? '?'} outChars=${outChars} maxOut=${maxOutputTokens}`,
            );
            if (finishReason === 'length') {
              console.warn(`  ⚠️ length: лимит ответа — attempt=${attempt}/${MAX_CONTINUATIONS}`);
            }
          },
          onError: ({ error }) => {
            console.error('  ↳ streamText error:', error);
          },
        });

        writer.merge(result.toUIMessageStream());
        const [finishReason, text] = await Promise.all([result.finishReason, result.text]);
        const textStr = String(text ?? '').trim();

        if (finishReason !== 'length' || !textStr) {
          if (finishReason === 'length' && !textStr) {
            const warnId = `length-warn-${Date.now()}`;
            writer.write({ type: "text-start", id: warnId });
            writer.write({
              type: "text-delta",
              id: warnId,
              delta: "⚠️ Ответ обрезан: исчерпан лимит контекста или max_tokens. Попробуйте новый чат или уменьшите объём расшифровки в одном запросе.",
            });
            writer.write({ type: "text-end", id: warnId });
          }
          break;
        }

        if (attempt >= MAX_CONTINUATIONS) break;

        continueMessages = [
          ...continueMessages,
          { role: 'assistant', content: textStr } as ModelMessage,
          { role: 'user', content: '[Авто-продолжение] Продолжи ответ точно с того места, где остановился. Не повторяй уже написанное.' } as ModelMessage,
        ];
      }
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
