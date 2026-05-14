import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";
import { buildRagHybridQueryPrompt, stripTextForRagQuery } from "@/lib/rag-search-query";

/** Добавляется к системному промпту, когда RAG включён. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Работа с расшифровкой через RAG-индекс

Пользователь загрузил расшифровку встречи в индекс. В блоке «КОНТЕКСТ ИЗ RAG» вверху — фрагменты из этой расшифровки (граф знаний + текстовые чанки). Используй их как основной источник фактов.

**Алгоритм для каждого раздела протокола:**
1. Вызови **retrieveFromIndexedDocuments** с запросом конкретных фактов из расшифровки (ФИО, темы, решения, даты — то, что нужно для текущего раздела).
2. Предложи заполнение раздела на основе найденного в excerpts — конкретные варианты, а не вопрос «что там было?».
3. Задай уточнение пользователю **только если** в excerpts нужной информации нет.

**ЗАПРЕЩЕНО** спрашивать «Кто участвовал?», «Какая повестка?», «Какие решения приняли?» — если расшифровка проиндексирована, ответ нужно искать через инструмент, а не задавать пользователю вопрос о содержании его же документа.

**Примеры purposeBrief для инструмента:**
- «Раздел 2 — темы и пункты повестки встречи»
- «Раздел 3 — ФИО, должности, организации участников встречи»
- «Раздел 6 — о чём говорили, ход обсуждения»
- «Раздел 8 — принятые решения, ответственные, сроки»

Если excerpts пусты или нерелевантны — скажи об этом кратко и задай один вопрос пользователю.

**Важно о разделе 2 (Повестка):** повестка — это **один абзац** 2–4 предложения о теме и цели встречи. Формулируй его из текста чанков (excerpts), а не перечисляй абстрактные понятия из Knowledge Graph. Никаких маркированных и нумерованных списков в разделе «Повестка».
`;

/** Фокус для автоматической генерации строки RAG-запроса перед ответом ассистента. */
export const RAG_AUTO_PURPOSE_FOCUS = `Определи, какой раздел протокола (1–10) заполняется сейчас по ходу диалога. Сформулируй поисковый запрос для извлечения КОНКРЕТНЫХ ФАКТОВ из загруженной расшифровки встречи:
- Раздел 1 → дата встречи, номер протокола, название встречи
- Раздел 2 → повестка, темы обсуждения, пункты встречи
- Раздел 3 → ФИО участников, должности, названия организаций заказчика и исполнителя
- Раздел 6 → ход обсуждения, о чём говорили, темы переговоров
- Раздел 8 → принятые решения, ответственные, сроки
НЕ ищи шаблоны и методички — ищи факты из расшифровки. Выведи одну поисковую строку.`;

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
  const cleaned = rawQuery.replace(/^["']|["']$/g, "").trim().slice(0, 800);
  return stripTextForRagQuery(cleaned);
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
          "По-русски: что именно ищем в расшифровке встречи. Пример: «Раздел 3 — ФИО, организации и должности всех участников встречи».",
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
