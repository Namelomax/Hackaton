import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";
import { buildRagHybridQueryPrompt, stripTextForRagQuery } from "@/lib/rag-search-query";

/** Добавляется к системному промпту, когда RAG включён: инструмент + при необходимости уже вставленный авто-блок RAG выше. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Индекс документов (RAG) — инструмент и авто-контекст
Пользователь **включил поиск по индексированным документам**. Вверху может быть блок **«КОНТЕКСТ ИЗ RAG»** (фрагменты из регламентов/шаблонов) — используй их **только если** там есть конкретные формулировки, релевантные текущему вопросу.

**Поведение диалога (важно):** твоя основная роль **не меняется** — работа по **расшифровке встречи** как в базовой инструкции: предлагай **варианты и формулировки из текста встречи**, задавай **одно** уточнение за сообщение, не превращай ответ в «опросник по всем 10 разделам подряд» только потому что включён RAG. RAG — **дополнение** (шаблоны «Форус», методички), а не замена расшифровки.

- Если блок RAG **пустой**, явно **бесполезен** или не по теме — **не опирайся** на него; отвечай из расшифровки и истории, как при выключенном RAG.
- Если в RAG есть **готовые формулировки** (таблицы, формулировки разделов) — можно кратко предложить **1–2 варианта** из них **вместе** с вариантами из расшифровки, не заменяя диалог одним сухим уточняющим вопросом.
- Дополнительный поиск — **retrieveFromIndexedDocuments**. В **purposeBrief** укажи **номер раздела 1–10** (если уместно) и суть того, что нужно из базы — например: «Раздел 8 — формулировка решений и ответственных по методичке».
- **Не выдумывай** цитаты из регламентов, если их нет в блоке RAG выше, в результате инструмента или во вложениях.
- После вызова инструмента опирайся на **excerpts**; если пусто — кратко скажи, что в индексе не нашлось, и продолжай из расшифровки.
- Инструмент **не** вызывай для чистого приветствия без запроса фактов из базы.
`;

/** Фокус для автоматической генерации строки запроса к RAG (до основного ответа ассистента). */
export const RAG_AUTO_PURPOSE_FOCUS = `Сначала выдели из последнего обмена **суть вопроса пользователя** (сущности, тема, что он хочет получить в ответе). Затем при необходимости добавь **номер раздела 1–10** протокола обследования, который лучше всего соответствует этому вопросу (если вопрос не про конкретный раздел — не навязывай номер). Сформулируй **одну** короткую поисковую строку по шаблонам и регламентам «Форус» под эту суть.`;

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
