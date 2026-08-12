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
import { generateFinalDocument } from "./document-agent";
import { PROTOCOL_TIMECODE_ADAPTATION_LINE } from "@/lib/protocol-timecodes";
import { createRetrieveFromIndexedDocumentsTool } from "./rag-tools";
import { createAddGlossaryRuleTool } from "./glossary-tools";
import { formatGlossaryForPrompt } from "@/lib/prompts/glossary";
import { documentReasoningOptions } from "@/lib/reasoning-options";
import { shouldPublishDocument } from "./publish-intent";
import {
  ollamaStreamHeartbeatMs,
  pickChatMaxOutputTokens,
} from "@/lib/ollama-limits";
import { deanonymize, deepDeanonymize } from "@/lib/anonymization";
import {
  filterToolCallLeakStream,
  looksLikeTextualToolCall,
} from "@/lib/tool-call-leak";

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

## Инструмент addProtocolGlossaryRule — запрет слов в протоколе
- Когда пользователь просит НЕ использовать слово/выражение в документе и/или говорит, чем заменять («не пиши "сделать", пиши "выполнить"», «убери "погнали" из протоколов») — вызови этот инструмент. Правило сохраняется навсегда и действует во всех будущих документах.
- После вызова коротко подтверди: «Добавил в глоссарий: "X" → "Y"». Для разовой правки конкретного места в текущем документе инструмент НЕ вызывай — просто исправь текст.
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

    const adaptation = `АДАПТАЦИЯ: Расшифровка получена
- Приветствие пропусти — расшифровка уже в системном блоке «ВЛОЖЕНИЯ»${useRagTool ? " и/или в RAG-индексе" : ""}. Сразу к делу.
- Следуй разделу «Поток диалога» из системной инструкции: Шаг 1 — скан + участники, Шаг 2 — повестка, Шаг 3 — содержание, Шаг 4 — сроки, Шаг 5 — подписи. Один шаг = одно сообщение; после «Верно» пользователя — следующий шаг.
- Первое сообщение после файла: сначала про себя просканируй расшифровку, затем предложи УЧАСТНИКОВ (Заказчик/Исполнитель, пометь молчавших) + явный блок «Не хватает: …» и обязательные вопросы про договор. Повестку, содержание и сроки на первом шаге НЕ включай.
- Минимум вопросов: только реальные пробелы и обязательные поля, одним нумерованным блоком в конце сообщения. НЕ «по одному вопросу + Верно?».
- ДОГОВОР обязателен: без номера, даты и темы договора publishInvestigationProtocol не вызывать.
- «Дата встречи» ≠ «дата договора»: ответ на вопрос о договоре НЕ перезаписывает дату встречи из расшифровки.
- ТАЙМ-КОДЫ: ${PROTOCOL_TIMECODE_ADAPTATION_LINE} Пример формата (имена условные, НЕ данные встречи): «00:02:47 — … ‹Фамилия Имя›, представитель ‹организация›» → «…‹организация› [ТС: 00:02:47].» Без [ТС: …] в ответе по расшифровке недопустимо. В финальный документ тайм-коды НЕ попадают.
- В чате ЗАПРЕЩЕНО выводить полный протокол из 5 разделов и заголовки финального документа — только через инструмент publishInvestigationProtocol (правая панель).
- Компания — «Форус», продукт — «протокол обследования».`;

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
  const refersToDocument =
    t.includes("документ") ||
    t.includes("протокол") ||
    t.includes("правой части") ||
    t.includes("правую часть") ||
    t.includes("прав панел") ||
    t.includes("правой панел") ||
    t.includes("панел");
  if (t.includes("обнови") && refersToDocument) return true;
  if (t.includes("переделай") && refersToDocument) return true;
  if (t.includes("поправ") && refersToDocument) return true;
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
  const anonymizeActive = Boolean(context.anonymize) && Object.keys(context.anonymizeMapping ?? {}).length > 0;
  const anonMapping = context.anonymizeMapping ?? {};
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
  const inlineTranscript = Boolean(hasInlineTranscript);
  let adaptedSystemPrompt =
    adaptSystemPrompt(systemPrompt, hasFiles, messages.length, {
      ragRetrievalEnabled: Boolean(ragRetrievalEnabled),
      hasInlineTranscript: inlineTranscript,
    }) +
    PROTOCOL_TOOL_SYSTEM_APPENDIX +
    formatGlossaryForPrompt();
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
  // Облачный режим (анонимизация активна → OpenRouter): лимиты Ollama не
  // применяем — облачные модели поддерживают большой вывод, а reasoning-модели
  // тратят бюджет на размышления и обрезались на середине ответа.
  const cloudMode = anonymizeActive;
  const maxOutputTokens = cloudMode
    ? Number(process.env.CLOUD_CHAT_MAX_OUTPUT_TOKENS ?? 16000)
    : pickChatMaxOutputTokens({
        hasInlineTranscript: inlineTranscript,
        dialogMessageCount,
      });
  console.log(
    `🤖 streamText start: msgs=${msgCount} dialog=${dialogMessageCount} input≈${estimatedInputTokens}tok (sys=${systemChars}c) maxOut=${maxOutputTokens} rag=${Boolean(ragRetrievalEnabled)} inlineDoc=${inlineTranscript}`,
  );
  // DEBUG_LLM_OUTBOUND=true — вывести в лог ВЕСЬ контекст, уходящий модели
  // (системный промпт + сообщения). Для ручной проверки анонимизации: в дампе
  // не должно быть реальных ФИО/организаций, только [PERSON_N]/[ORG_N].
  if (process.env.DEBUG_LLM_OUTBOUND === 'true') {
    console.log('┏━━━ OUTBOUND SYSTEM PROMPT (chat-agent) ━━━\n' + adaptedSystemPrompt + '\n┗━━━ END SYSTEM ━━━');
    console.log(
      '┏━━━ OUTBOUND MESSAGES ━━━\n' +
        messagesWithUserPrompt
          .map((m) => `[${m.role}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n---\n') +
        '\n┗━━━ END MESSAGES ━━━',
    );
  }
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
        addProtocolGlossaryRule: createAddGlossaryRuleTool(),
        ...(retrieveFromIndexedDocumentsTool
          ? { retrieveFromIndexedDocuments: retrieveFromIndexedDocumentsTool }
          : {}),
      };

      let continueMessages: ModelMessage[] = messagesWithUserPrompt;
      let lastAssistantText = "";
      const MAX_CONTINUATIONS = 0;

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
          // Единый набор опций отключения размышлений (lib/reasoning-options):
          // тот же, что у генерации документа, правок и проверки. Раньше здесь
          // не хватало exclude:true, и модель всё равно думала — замер показал
          // 12 810 токенов ради ответа в 145 символов.
          providerOptions: documentReasoningOptions(),
          stopWhen: stepCountIs(ragRetrievalEnabled ? 4 : 3),
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

        // sendReasoning: false — внутренние размышления модели (reasoning-части)
        // не отправляются в чат: пользователь видит только итоговый ответ.
        // filterToolCallLeakStream: слабая локальная модель пишет вызов
        // инструмента ТЕКСТОМ («<|tool_call>call:publishInvestigationProtocol…»).
        // Ниже это ловит фолбэк и всё равно собирает документ, но сама разметка
        // без фильтра уезжала пользователю в чат и сохранялась в историю.
        writer.merge(
          filterToolCallLeakStream(result.toUIMessageStream({ sendReasoning: false })),
        );
        const [finishReason, text] = await Promise.all([result.finishReason, result.text]);
        const textStr = String(text ?? '').trim();
        lastAssistantText = textStr;

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

      // 🛟 ФОЛБЭК «текстовый tool-call»: слабая модель часто ПИШЕТ аргументы
      // инструмента текстом ({"reasonBrief": …}) или заявляет «правки внесены»,
      // но реального вызова publishInvestigationProtocol не делает — панель не
      // обновляется. Детектируем это и генерируем документ детерминированно.
      if (!sink.markdown || sink.markdown.trim().length === 0) {
        const t = lastAssistantText.trim();
        // Модель нередко «протекает» вызовом инструмента в текст. Признаки
        // (см. lib/tool-call-leak.ts): имя параметра `reasonBrief`, имя самого
        // инструмента и любые tool_call-границы. Ни одно из этого в нормальном
        // русском ответе пользователю не встречается — промпт прямо запрещает
        // упоминать инструмент, — поэтому находка ГДЕ УГОДНО в тексте надёжна.
        // Раньше признак был один (`reasonBrief:`), и псевдовызов без имени
        // параметра проходил мимо: документ не пересобирался молча.
        const textualToolJson = looksLikeTextualToolCall(t);
        // Намерение обновить документ определяет МОДЕЛЬ, а не список подстрок.
        // Список ожидаемо промахивался: ответ «Формирую протокол» мимо него
        // прошёл (в списке было причастие «сформирован»), инструмент не
        // вызвался, и документ не собрался вообще — 2 секунды и protocol=none.
        let intent: boolean | null = null;
        if (hasDocument && !textualToolJson) {
          intent = await shouldPublishDocument({
            model,
            userText: lastUserText,
            assistantText: t,
            abortSignal: abortSignal ?? undefined,
          });
          // Классификатор недоступен — грубая подстраховка прежним признаком,
          // чтобы не потерять обновление совсем.
          if (intent === null) {
            intent =
              /(обновл|внес|внёс|исправл|замен|формир|соберу|собираю)/i.test(t) && !t.includes('?');
          }
        }
        const shouldForce = textualToolJson || Boolean(intent);
        if (shouldForce) {
          try {
            console.warn(
              `🛟 tool fallback: textualJson=${textualToolJson} publishIntent=${intent} → generateFinalDocument напрямую`,
            );
            const md = await generateFinalDocument(
              safeOriginalUIMessages(context),
              context.userPrompt,
              writer,
              model,
              documentContent,
              conversationId ?? null,
              0,
              abortSignal ?? undefined,
              { anonymize: anonymizeActive, mapping: anonMapping },
            );
            sink.markdown = md;
            const okId = `tool-fallback-${Date.now()}`;
            writer.write({ type: "text-start", id: okId });
            writer.write({
              type: "text-delta",
              id: okId,
              delta: "Документ обновлён в правой панели.",
            });
            writer.write({ type: "text-end", id: okId });
          } catch (e) {
            // Раньше ошибка тут только логировалась — пользователь видел исходное
            // «правки внесены» от модели и считал, что всё обновилось, хотя панель
            // осталась старой. Теперь явно сообщаем о сбое в чате.
            console.error("🛟 tool fallback failed:", e);
            const failId = `tool-fallback-fail-${Date.now()}`;
            writer.write({ type: "text-start", id: failId });
            writer.write({
              type: "text-delta",
              id: failId,
              delta:
                "⚠️ Не удалось автоматически обновить документ в правой панели (ошибка формирования протокола). Попробуйте переформулировать правку или повторить запрос ещё раз.",
            });
            writer.write({ type: "text-end", id: failId });
          }
        }
      }
    },
    onFinish: async ({ messages: finished }) => {
      const elapsed = Date.now() - agentStartMs;
      console.log(`✅ agent done: ${elapsed}ms total, protocol=${sink.markdown.length > 0 ? sink.markdown.length + ' chars' : 'none'}`);
      if (!userId) return;
      try {
        // В режиме анонимизации модель отвечает плейсхолдерами — в БД сохраняем
        // реальные данные (как видит пользователь), чтобы при перезагрузке диалога
        // не показывались [PERSON_1] и т.п.
        const persistMessages = anonymizeActive
          ? deepDeanonymize(finished, anonMapping)
          : finished;
        let doc =
          typeof sink.markdown === "string" && sink.markdown.trim().length > 0
            ? sink.markdown
            : undefined;
        if (doc && anonymizeActive) doc = deanonymize(doc, anonMapping);
        if (conversationId) {
          await updateConversation(conversationId, persistMessages, doc);
        } else {
          await saveConversation(userId, persistMessages, doc);
        }
      } catch (e) {
        console.error("chat persistence failed", e);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
