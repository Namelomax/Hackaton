import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";
import {
  buildRagHybridQueryPrompt,
  fallbackRagQuestionFromTranscript,
  looksLikeKeywordSoupQuery,
  RAG_QUERY_MAX_CHARS,
  stripTextForRagQuery,
} from "@/lib/rag-search-query";

/** Добавляется к системному промпту, когда RAG включён. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Работа с расшифровкой через RAG-индекс

Пользователь загрузил расшифровку встречи в индекс. В блоке «КОНТЕКСТ ИЗ RAG» вверху — фрагменты из этой расшифровки (граф знаний + текстовые чанки). Используй их как основной источник фактов.

**Алгоритм для каждого раздела протокола:**
1. Определи СЛЕДУЮЩИЙ незаполненный раздел (1–10). Если пользователь подтвердил раздел 1 («верно», «да») — ищи данные для раздела 2, не повторяй раздел 1.
2. Вызови **retrieveFromIndexedDocuments** с purposeBrief в форме **вопроса** о расшифровке (не список ключевых слов).
3. Предложи заполнение раздела по excerpts; уточни у пользователя **только если** excerpts пусты или нерелевантны.

**Данные от пользователя в чате** (номер протокола, дата, название), которые он **сам написал**:
- принимай как **истину для протокола** без фразы «в расшифровке не найдено»;
- **не проси подтвердить**, что они верны — пользователь уже задал их;
- сразу переходи к **следующему** разделу (обычно 2 — повестка) и ищи в RAG только то, чего пользователь не вводил.

**ЗАПРЕЩЕНО** отвечать «не найдено в расшифровке» без вызова инструмента — кроме полей, которые пользователь уже явно назвал в этом диалоге.
**ЗАПРЕЩЕНО** спрашивать «какая повестка?» / «кто участвовал?», не вызвав инструмент с вопросом к индексу.

**Примеры purposeBrief (вопросная форма):**
- «Какие темы и пункты планировали обсудить на встрече?» (раздел 2)
- «Кто участвовал, ФИО, должности и организации?» (раздел 3)
- «Какие решения приняли и кто ответственный?» (раздел 8)

Если excerpts пусты или нерелевантны — скажи об этом кратко и задай один вопрос пользователю.

**Важно о разделе 2 (Повестка):** повестка — это **один абзац** 2–4 предложения о теме и цели встречи. Формулируй его из текста чанков (excerpts), а не перечисляй абстрактные понятия из Knowledge Graph. Никаких маркированных и нумерованных списков в разделе «Повестка».
`;

/** Фокус для автоматической генерации строки RAG-запроса перед ответом ассистента. */
export const RAG_AUTO_PURPOSE_FOCUS = `
Определи, какой раздел протокола (1–10) пользователь только что закрыл (подтвердил «верно», «да» или дал данные).
Сформулируй цель поиска для СЛЕДУЮЩЕГО раздела — что найти в расшифровке встречи.
Пример: закрыт раздел 1 (дата/номер) → следующий 2 → цель: повестка, темы и пункты обсуждения.
Не смешивай несколько разделов в одном запросе. Не ищи шаблоны — только факты из расшифровки.
Итог — один вопрос на русском для поиска по тексту встречи.
`.trim();

function modelMessagesToTranscript(messages: ModelMessage[], maxChars: number): string {
  const tail = messages.slice(-24);
  const lines: string[] = [];
  for (const m of tail) {
    const role = m.role;
    let text = "";
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((part: unknown) => {
          if (!part || typeof part !== "object") return "";
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") return p.text;
          return "";
        })
        .join("");
    }
    const trimmed = stripTextForRagQuery(text.replace(/\s+/g, " ").trim());
    if (!trimmed) continue;
    lines.push(`${role}: ${trimmed}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

export type RagToolFactoryContext = {
  model: unknown;
  /** Снимок диалога на момент вызова (те же сообщения, что у основного агента). */
  messages: ModelMessage[];
  ragMode: string;
  abortSignal?: AbortSignal | null;
  /** ID диалога для изоляции RAG-индекса (каждый диалог — свой индекс). */
  conversationId?: string | null;
};

/** Одна строка запроса к hybrid RAG по промпту с 10 разделами протокола (общая логика с инструментом). */
export async function generateRagSearchQueryLine(options: {
  model: unknown;
  transcript: string;
  purposeFocus: string;
  abortSignal?: AbortSignal | null;
}): Promise<string> {
  const { text: rawQuery } = await generateText({
    model: options.model as any,
    temperature: 0,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    prompt: buildRagHybridQueryPrompt(options.transcript, options.purposeFocus),
  });
  let cleaned = rawQuery.replace(/^["']|["']$/g, "").trim();
  cleaned = stripTextForRagQuery(cleaned).slice(0, RAG_QUERY_MAX_CHARS);

  if (!cleaned || looksLikeKeywordSoupQuery(cleaned)) {
    const fallback = fallbackRagQuestionFromTranscript(options.transcript);
    if (fallback) {
      console.info(
        "[RAG query] keyword-soup or empty LLM output; heuristic fallback:",
        fallback.slice(0, 120),
      );
      return fallback;
    }
  }

  if (!cleaned.endsWith("?") && cleaned.length > 20) {
    cleaned = `${cleaned.replace(/[.!]+$/, "")}?`;
  }

  return cleaned;
}

/**
 * Инструмент: внутри — отдельный вызов LLM, который по контексту диалога и цели
 * формулирует поисковый запрос к RAG, затем выполняется retrieval.
 */
export function createRetrieveFromIndexedDocumentsTool(ctx: RagToolFactoryContext) {
  return tool({
    description: `Найти фрагменты из расшифровки встречи (загруженный документ проиндексирован). Используй для извлечения конкретных фактов: кто участвовал, что обсуждали, какие решения приняли, кто ответственный, даты и сроки. В purposeBrief укажи, что именно ищешь в тексте расшифровки.`,
    inputSchema: z.object({
      purposeBrief: z
        .string()
        .min(3)
        .max(500)
        .describe(
          "Вопрос к расшифровке (не список слов). Пример: «Кто участвовал во встрече, ФИО, должности и организации?» — для СЛЕДУЮЩЕГО раздела после подтверждения предыдущего.",
        ),
    }),
    execute: async ({ purposeBrief }) => {
      console.info("[retrieveFromIndexedDocuments]", purposeBrief.slice(0, 240));
      const transcript = modelMessagesToTranscript(ctx.messages, 12000);
      try {
        const searchQueryUsed = await generateRagSearchQueryLine({
          model: ctx.model,
          transcript,
          purposeFocus: purposeBrief,
          abortSignal: ctx.abortSignal ?? undefined,
        });
        if (!searchQueryUsed) {
          return {
            searchQueryUsed: "",
            excerpts: "",
            note: "Пустой поисковый запрос — повтори вызов с более конкретным purposeBrief.",
          };
        }

        const excerpts = await fetchRagSnippet(searchQueryUsed, ctx.ragMode || "hybrid", ctx.conversationId);
        return {
          searchQueryUsed,
          excerpts: excerpts || "(RAG не вернул фрагментов по этому запросу.)",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          searchQueryUsed: "",
          excerpts: "",
          note: `Ошибка при обращении к RAG или генерации запроса: ${msg}`,
        };
      }
    },
  });
}
