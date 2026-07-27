/**
 * «Собирался ли агент обновить документ?» — решает модель, а не регулярка.
 *
 * Слабые модели регулярно пишут о правке текстом, но не вызывают инструмент
 * публикации — панель остаётся старой. Раньше этот случай ловился списком
 * подстрок («обновл», «внес», «сформирован»…), и он ожидаемо промахивался:
 * на живом стенде ответ «Формирую протокол» мимо списка не прошёл — там было
 * причастие «сформирован», а не «формирую», — и документ не собрался вообще.
 *
 * Перечислять формы глаголов бессмысленно, их бесконечно много. Спрашиваем у
 * модели: обещает ли этот ответ обновление документа прямо сейчас.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { documentReasoningOptions } from '@/lib/reasoning-options';

const IntentSchema = z.object({
  publish: z
    .boolean()
    .describe('true — ответ обещает/утверждает обновление протокола прямо сейчас'),
  reason: z.string().max(200).default(''),
});

const PROMPT = `Ты определяешь, нужно ли пересобрать документ протокола после ответа ассистента.

Верни publish = true, если ответ ассистента обещает обновить протокол прямо сейчас или утверждает, что уже обновил его: «формирую протокол», «сейчас соберу», «обновляю документ», «правки внесены», «протокол обновлён в правой панели» и любые другие формулировки того же смысла в любом времени и виде.

Верни publish = false, если ассистент:
- задаёт уточняющий вопрос и ждёт ответа;
- просто отвечает на вопрос пользователя, ничего не меняя;
- перечисляет, что нужно уточнить, но не берётся собирать документ;
- предлагает варианты и ждёт выбора.

Смотри на смысл, а не на отдельные слова.

=== СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ ===
{{USER}}

=== ОТВЕТ АССИСТЕНТА ===
{{ASSISTANT}}`;

/**
 * @returns true — надо вызвать генерацию документа за модель.
 *   При любой ошибке возвращает null: вызывающий код решает сам.
 */
export async function shouldPublishDocument(options: {
  model: any;
  userText: string;
  assistantText: string;
  abortSignal?: AbortSignal;
}): Promise<boolean | null> {
  const { model, userText, assistantText, abortSignal } = options;
  const text = assistantText.trim();
  if (!text) return null;

  try {
    const result = await generateObject({
      model,
      schema: IntentSchema,
      prompt: PROMPT.replace('{{USER}}', userText.slice(0, 2000)).replace(
        '{{ASSISTANT}}',
        text.slice(0, 4000),
      ),
      temperature: 0,
      maxOutputTokens: 256,
      providerOptions: documentReasoningOptions(),
      ...(abortSignal ? { abortSignal } : {}),
    });
    console.log(
      `[publish-intent] publish=${result.object.publish} (${result.object.reason || 'без пояснения'})`,
    );
    return result.object.publish;
  } catch (err) {
    console.warn('[publish-intent] определить намерение не удалось:', (err as Error)?.message);
    return null;
  }
}
