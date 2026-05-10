import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";

/** Добавляется к системному промпту, когда RAG включён: инструмент + при необходимости уже вставленный авто-блок RAG выше. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Индекс документов (RAG) — инструмент и авто-контекст
Пользователь **включил поиск по индексированным документам**. Вверху в системном сообщении может уже быть блок **«КОНТЕКСТ ИЗ RAG»** (автопоиск по последним репликам пользователя) — опирайся на него для фактов.

- Если этого недостаточно или нужен **другой фокус** (другая тема, уточнение по договору и т.д.) — вызови **retrieveFromIndexedDocuments** с чётким purposeBrief; при сложном вопросе допустимо несколько вызовов.
- **Не выдумывай** цитаты из «документов компании», если их нет ни в блоке RAG выше, ни в результате инструмента, ни во вложениях текущего сообщения.
- После вызова инструмента опирайся на поле **excerpts**; если пусто — так и скажи пользователю.
- Инструмент **не** вызывай только для чистого приветствия без запроса фактов или если ответ целиком следует из уже видимого в диалоге и блока RAG выше достаточно.
`;

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

/**
 * Инструмент: внутри — отдельный вызов LLM, который по контексту диалога и цели
 * формулирует поисковый запрос к RAG, затем выполняется retrieval.
 */
export function createRetrieveFromIndexedDocumentsTool(ctx: RagToolFactoryContext) {
  return tool({
    description: `Получить релевантные фрагменты из индексированной базы документов (RAG). Используй, когда для ответа пользователю нужны факты из корпоративных материалов, загруженных в индекс — не для общих рассуждений. Внутри инструмента автоматически строится оптимизированный поисковый запрос по текущему диалогу и твоей формулировке цели.`,
    inputSchema: z.object({
      purposeBrief: z
        .string()
        .min(3)
        .max(500)
        .describe(
          "Кратко по-русски: что именно нужно найти в документах (тема, сущности, ограничения). Например: «требования к оформлению протокола», «сроки поставки по договору X».",
        ),
    }),
    execute: async ({ purposeBrief }) => {
      console.info("[retrieveFromIndexedDocuments]", purposeBrief.slice(0, 240));
      const transcript = modelMessagesToTranscript(ctx.messages, 12000);
      try {
        const { text: rawQuery } = await generateText({
          model: ctx.model as any,
          temperature: 0,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          prompt: `Ты формулируешь ОДИН поисковый запрос для гибридного поиска (семантика + ключевые слова) по корпоративным документам.

Фрагмент диалога (последние реплики, user = пользователь, assistant = ты):
"""
${transcript}
"""

Фокус поиска (формулировка ассистента): ${purposeBrief}

ПРАВИЛА:
- Выведи ТОЛЬКО текст запроса одной строкой, без кавычек, префиксов и пояснений.
- Включи конкретные термины из диалога: названия, даты, номера, ФИО, продукты — если они помогают retrieval.
- Длина не более 600 символов.
- Язык: русский, если в диалоге преобладает русский; иначе допустим английский для редких терминов.`,
        });

        const searchQueryUsed = rawQuery.replace(/^["']|["']$/g, "").trim().slice(0, 800);
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
