import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";
import { buildRagHybridQueryPrompt } from "@/lib/rag-search-query";

/** Добавляется к системному промпту, когда RAG включён: инструмент + при необходимости уже вставленный авто-блок RAG выше. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Индекс документов (RAG) — инструмент и авто-контекст
Пользователь **включил поиск по индексированным документам**. Вверху в системном сообщении может уже быть блок **«КОНТЕКСТ ИЗ RAG»** (автопоиск по диалогу с учётом **10 разделов протокола обследования по порядку**) — опирайся на него для фактов и формулировок из регламентов.

- Дополнительный поиск — **retrieveFromIndexedDocuments**. В поле **purposeBrief** всегда указывай **номер раздела 1–10** (или два номера, если вопрос на стыке), зачем он нужен, и чего хочет пользователь — например: «Раздел 3 протокола — требования к таблице участников заказчика».
- Если этого недостаточно или нужен **другой фокус** — вызови инструмент ещё раз с другим purposeBrief.
- **Не выдумывай** цитаты из «документов компании», если их нет ни в блоке RAG выше, ни в результате инструмента, ни во вложениях текущего сообщения.
- После вызова инструмента опирайся на поле **excerpts**; если пусто — так и скажи пользователю.
- Инструмент **не** вызывай только для чистого приветствия без запроса фактов или если ответ целиком следует из уже видимого в диалоге и блока RAG выше достаточно.
`;

/** Фокус для автоматической генерации строки запроса к RAG (до основного ответа ассистента). */
export const RAG_AUTO_PURPOSE_FOCUS = `Автоматический режим: по последнему обмену в диалоге определи **текущий этап** — какой из **10 разделов протокола обследования** сейчас актуален (или какой раздел затрачивает последний вопрос пользователя). Сформулируй запрос к базе шаблонов и регламентов **строго под этот раздел** и под формулировку пользователя.`;

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
    const trimmed = text.replace(/\s+/g, " ").trim();
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
  return rawQuery.replace(/^["']|["']$/g, "").trim().slice(0, 800);
}

/**
 * Инструмент: внутри — отдельный вызов LLM, который по контексту диалога и цели
 * формулирует поисковый запрос к RAG, затем выполняется retrieval.
 */
export function createRetrieveFromIndexedDocumentsTool(ctx: RagToolFactoryContext) {
  return tool({
    description: `Получить фрагменты из индекса (шаблоны протокола обследования, регламенты «Форус»). Внутри по диалогу определяется этап по **10 разделам протокола** и формируется поисковая строка. Вызывай, когда нужны факты из базы; в purposeBrief укажи **номер раздела 1–10** и суть.`,
    inputSchema: z.object({
      purposeBrief: z
        .string()
        .min(3)
        .max(500)
        .describe(
          "По-русски: **раздел 1–10** протокола обследования + что искать (термины, ответственные за решение и т.д.). Пример: «Раздел 8 — как формулировать решения и ответственных по методичке Форус».",
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

        const excerpts = await fetchRagSnippet(searchQueryUsed, ctx.ragMode || "hybrid");
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
