import { generateText, tool } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { fetchRagSnippet } from "@/lib/rag-client";

/** Добавляется к системному промпту, когда RAG включён: без пре-инъекции ответа, только через инструмент. */
export const RAG_TOOL_MODE_SYSTEM_APPENDIX = `

## Индекс документов (RAG) — режим инструмента
Пользователь **включил поиск по индексированным документам**. Готового блока «контекст из RAG» в этом сообщении **нет** — его нужно получить самому.

- Когда для ответа нужны **факты из регламентов, договоров, внутренних документов, инструкций** или других материалов из базы знаний, вызови инструмент **retrieveFromIndexedDocuments** (можно несколько раз с разными фокусами, если вопрос многосоставной).
- **Не выдумывай** цитаты и детали из «документов компании», если ты их не получил через этот инструмент (или они явно есть во вложениях выше).
- После вызова опирайся на поле **excerpts** в результате инструмента; если фрагменты пусты или не по теме — так и скажи пользователю.
- Обычные уточняющие вопросы, приветствие, работа только с расшифровкой встречи **без** обращения к базе документов — инструмент **не** вызывай.
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
