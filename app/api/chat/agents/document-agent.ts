import { createUIMessageStream, JsonToSseTransformStream, streamObject, generateObject } from 'ai';
import { AgentContext } from './types';
import {
  updateConversation,
  saveConversation,
  saveConversationProtocolJson,
  getConversationProtocolJson,
} from '@/lib/getPromt';
import {
  planProtocolPatch,
  applyEditsToProtocol,
  mapProtocolStrings,
} from './protocol-patch';
import {
  ProtocolSchema,
  coerceProtocolPartial,
  parseProtocolStrict,
  extractNoObjectGeneratedText,
  parseLooseJsonObject,
  type Protocol,
} from '@/lib/schemas/protocol-schema';
import { generateProtocolDocx } from '@/lib/docx-generator';
import { verifyProtocolSections } from '@/lib/protocol-verify';
import { SGR_DOCUMENT_AGENT_PROMPT } from '@/lib/prompts/sgr-prompts';
import { PROTOCOL_REGULATION } from '@/lib/prompts/regulation';
import { ollamaProtocolMaxOutputTokens, cloudProtocolMaxOutputTokens } from '@/lib/ollama-limits';
import { consumePartialObjectStream } from './partial-object-stream';
import {
  buildProtocolDraftFromChat,
  formatChatDraftForPrompt,
  extractLatestUserCorrections,
  extractUserAnswerTexts,
  mergeProtocolWithChatDraft,
} from '@/lib/protocol-chat-extract';
import { applyGlossaryToProtocol, formatGlossaryForPrompt } from '@/lib/prompts/glossary';
import {
  stripProtocolTimecodes,
  carryOverParticipantRoles,
  applyPositionOverrides,
  enforceDateProvenance,
  reconcileWithApproved,
  fillContractFromDialogue,
  flagRelativeDates,
  fillHeaderFromDialogue,
  resolveRelativeDates,
  dropInventedMeetingDate,
  ensureProtocolNumber,
  normalizeProtocolNumbers,
  unifyUnresolvedMarkers,
  dedupeParticipants,
} from '@/lib/protocol-guards';
import { buildDateContextBlock, resolveRelativeDatesInText } from '@/lib/date-context';
import { documentReasoningOptions, formatUsage } from '@/lib/reasoning-options';
import {
  cleanProtocolText,
  formatProtocolSectionHeading,
  formatContractBlock,
  formatSummaryDecisionForMarkdown,
  isValidParticipantRow,
  resolveApprovalForDocument,
} from '@/lib/protocol-markdown-format';
import { applyMappingForward, deanonymize, deepDeanonymize, type Mapping } from '@/lib/anonymization';
import { ANONYMIZE_MODE_SYSTEM_APPENDIX, buildGenderHintsBlock } from '@/lib/anonymization/prompt';

function extractMessageText(msg: any): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg?.parts)) {
    const texts = msg.parts
      .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean);
    if (texts.length) return texts.join(' ');
  }
  if (msg?.content && typeof msg.content === 'object') {
    try {
      return JSON.stringify(msg.content);
    } catch (e) {
      return String(msg.content);
    }
  }
  return '';
}

function stripTimecodeMarkers(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{\{ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\}\}/gi, '')
    .replace(/\[ТС:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\[TC:\s*\d{1,2}:\d{2}(?::\d{2})?\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runDocumentAgent(context: AgentContext) {
  const { messages, uiMessages, model, userPrompt, documentContent, userId, conversationId, abortSignal } =
    context;
  const anonymize = Boolean(context.anonymize);
  const anonymizeMapping: Mapping = context.anonymizeMapping ?? {};
  let generatedDocumentContent = '';

  const safeOriginalUIMessages = (() => {
    if (Array.isArray(uiMessages) && uiMessages.length > 0) return uiMessages as any;
    // Minimal fallback shape expected by `createUIMessageStream`.
    return (Array.isArray(messages) ? messages : []).map((m: any, idx: number) => {
      const text = typeof m?.content === 'string' ? m.content : '';
      return {
        id: String(m?.id ?? `m-${idx}-${Date.now()}`),
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        parts: [{ type: 'text', text }],
        metadata: m?.metadata ?? {},
      };
    });
  })();

  const stream = createUIMessageStream({
    originalMessages: safeOriginalUIMessages,
    execute: async ({ writer }) => {
      try {
        // Use uiMessages for conversation context as they contain the original dialogue history
        generatedDocumentContent = await generateFinalDocument(
          uiMessages || [], // Use uiMessages instead of messages, with fallback
          userPrompt,
          writer,
          model,
          documentContent,
          conversationId,
          0,
          abortSignal ?? undefined,
          { anonymize, mapping: anonymizeMapping },
        );
        const doneId = `done-${Date.now()}`;
        writer.write({ type: 'text-start', id: doneId });
        writer.write({ type: 'text-delta', id: doneId, delta: 'Протокол обследования сформирован.' });
        writer.write({ type: 'text-end', id: doneId });
      } catch (error) {
        console.error('Document generation error:', error);
        // Если генерация успела частично перезаписать панель — возвращаем
        // предыдущую версию одним обновлением, без промежуточной пустоты.
        if (typeof documentContent === 'string' && documentContent.trim()) {
          writer.write({ type: 'data-documentSet', data: documentContent, transient: true });
        }
        const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
        writer.write({ type: 'text-start', id: 'error' });
        writer.write({
          type: 'text-delta',
          id: 'error',
          delta: `Не удалось сформировать документ.${detail} Предыдущая версия протокола сохранена — попробуйте ещё раз.`,
        });
        writer.write({ type: 'text-end', id: 'error' });
      }
    },
    onFinish: async ({ messages: finished }) => {
      if (userId) {
        try {
          if (conversationId) {
            await updateConversation(conversationId, finished, generatedDocumentContent);
          } else {
            await saveConversation(userId, finished, generatedDocumentContent);
          }
        } catch (e) {
          console.error('document persistence failed', e);
        }
      }
    }
  });

  // Поток должен быть БАЙТОВЫМ: wrapResponseWithDeanonymization в route.ts
  // (облачный режим с анонимизацией) ожидает Uint8Array-чанки, а
  // JsonToSseTransformStream по умолчанию отдаёт строки — без этого шага
  // деанонимизация падала с TypeError на decoder.decode(chunk).
  const readable = stream
    .pipeThrough(new JsonToSseTransformStream())
    .pipeThrough(new TextEncoderStream());
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
}

/** Генерация протокола в правую панель (`data-title`, `data-documentDelta`, …). Пишет в переданный writer. */
export async function generateFinalDocument(
  uiMessages: any[], // Changed from messages to uiMessages
  userPrompt: string | null,
  dataStream: any,
  model: any,
  existingDocument?: string,
  conversationId?: string | null,
  temperature: number = 0,
  abortSignal?: AbortSignal,
  anonOptions?: { anonymize?: boolean; mapping?: Mapping },
): Promise<string> {
  const anonymizeActive = Boolean(anonOptions?.anonymize) && Object.keys(anonOptions?.mapping ?? {}).length > 0;
  const anonMapping: Mapping = anonOptions?.mapping ?? {};
  const writeData = (payload: { type: string; data: any; id?: string; transient?: boolean }) => {
    dataStream.write({
      type: payload.type,
      data: payload.data,
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.transient ? { transient: payload.transient } : {}),
    });
  };

  // Извлекаем всю историю диалога (расшифровку встречи) из uiMessages.
  // ВАЖНО: текст загруженных файлов (расшифровка) лежит НЕ в content, а в
  // metadata.hiddenTexts (см. route.ts «3. Process Attachments»). Раньше агент
  // документа его не читал — поэтому в документ не попадала расшифровка и
  // разделы 2/4 оказывались пустыми или выдуманными. Теперь подмешиваем её явно.
  const MAX_TRANSCRIPT_CHARS = Number(process.env.DOC_MAX_TRANSCRIPT_CHARS ?? 60000);
  const conversationContext = uiMessages
    .map((msg) => {
      // Extract text from uiMessages format (parts array)
      let text = '';
      if (Array.isArray(msg?.parts)) {
        text = msg.parts
          .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join(' ');
      }
      // Fallback to content if parts didn't yield text
      if (!text && typeof msg?.content === 'string') {
        text = msg.content;
      }

      // Текст вложений (расшифровка встречи) из metadata.hiddenTexts
      const hiddenTexts: string[] = Array.isArray((msg as any)?.metadata?.hiddenTexts)
        ? (msg as any).metadata.hiddenTexts.filter(
            (h: unknown) => typeof h === 'string' && h.trim().length > 0,
          )
        : [];
      let transcriptBlock = '';
      if (hiddenTexts.length > 0) {
        let joined = hiddenTexts.join('\n\n');
        if (joined.length > MAX_TRANSCRIPT_CHARS) {
          joined =
            joined.slice(0, MAX_TRANSCRIPT_CHARS) +
            '\n…(расшифровка обрезана по лимиту DOC_MAX_TRANSCRIPT_CHARS)…';
        }
        transcriptBlock = `\n[РАСШИФРОВКА ВСТРЕЧИ — первоисточник фактов для разделов 2 и 4]:\n${joined}`;
      }

      const combined = [text, transcriptBlock].filter(Boolean).join('\n');
      const cleaned = stripTimecodeMarkers(combined);
      return cleaned ? `${msg.role}: ${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n');

  // Подготовка контекста существующего документа (если есть ручные правки)
  const existingDocumentContext = existingDocument && existingDocument.trim()
    ? `\n\nСУЩЕСТВУЮЩАЯ ВЕРСИЯ ДОКУМЕНТА — ЭТО БАЗА ДЛЯ СБОРКИ.\nПеренесите её в JSON дословно и внесите только те изменения, о которых просил пользователь. Всё остальное — теми же словами, что и здесь.\n"""\n${existingDocument}\n"""\n\n`
    : '';

  const chatDraft = buildProtocolDraftFromChat(uiMessages);
  const userCorrections = extractLatestUserCorrections(uiMessages);
  // Реквизиты договора/шапки — только из явных ответов пользователя, НЕ из всей
  // расшифровки: иначе гард склеивает липовые данные из случайных упоминаний
  // «договор №…» в тексте встречи (см. fillContractFromDialogue/fillHeaderFromDialogue).
  const userAnswersText = extractUserAnswerTexts(uiMessages || []).join('\n');
  const agreedChatContext = formatChatDraftForPrompt(chatDraft, userCorrections);
  if (Object.keys(chatDraft).length > 0 || userCorrections.length > 0) {
    console.log(
      `[generateFinalDocument] chat draft: agenda=${chatDraft.agenda?.items?.length ?? 0} topics=${chatDraft.meetingContent?.topics?.length ?? 0} summary=${chatDraft.meetingContent?.summary?.length ?? 0} approval_cust=${chatDraft.approval?.customer?.signatories?.length ?? 0} corrections=${userCorrections.length}`,
    );
  }

  // ── Точечная правка вместо полной пересборки ────────────────────────────
  // Если протокол уже сформирован и пользователь уточняет отдельные места,
  // пересобирать документ целиком нельзя: модель заодно переписывает соседние
  // формулировки. Пробуем применить точечные замены к сохранённому Protocol JSON.
  const patchedMarkdown = await tryPatchExistingProtocol({
    conversationId,
    userRequest: lastUserMessageText(uiMessages),
    // Документ, который СЕЙЧАС открыт у пользователя: нужен, чтобы убедиться,
    // что сохранённая база патча — та же версия. Иначе правим одно, а человек
    // смотрит на другое.
    visibleDocument: existingDocument ?? '',
    model,
    writeData,
    dataStream,
    anonymizeActive,
    anonMapping,
    abortSignal,
  });
  if (patchedMarkdown) return patchedMarkdown;

  // Режим анонимизации: всё, что уходит в облачную модель, должно быть в плейсхолдерах.
  const promptConversationContext = anonymizeActive
    ? applyMappingForward(conversationContext, anonMapping)
    : conversationContext;
  const promptExistingDocumentContext = anonymizeActive
    ? applyMappingForward(existingDocumentContext, anonMapping)
    : existingDocumentContext;
  const promptAgreedChatContext = anonymizeActive
    ? applyMappingForward(agreedChatContext, anonMapping)
    : agreedChatContext;

  // Use SGR-enhanced document generation prompt
  const protocolPrompt = (anonymizeActive ? ANONYMIZE_MODE_SYSTEM_APPENDIX + buildGenderHintsBlock(anonMapping) + '\n\n' : '') + SGR_DOCUMENT_AGENT_PROMPT
    .replace('{{REGULATION}}', PROTOCOL_REGULATION + formatGlossaryForPrompt())
    .replace('{{CONVERSATION_CONTEXT}}', promptConversationContext)
    .replace('{{EXISTING_DOCUMENT_CONTEXT}}', promptExistingDocumentContext)
    .replace(
      '{{AGREED_CHAT_CONTEXT}}',
      promptAgreedChatContext ||
        '(Отдельный блок согласованных разделов не выделен — используйте подтверждённые пользователем формулировки из истории диалога.)',
    ) +
    // Агенту документа справка о дате нужна не меньше, чем чат-агенту: без неё
    // «в четверг» не превратить в дату. Блок явно отделяет «сегодня» от даты
    // встречи — раньше модель ставила сегодняшнее число в шапку протокола.
    buildDateContextBlock();

  let markdownContent = '';

  // DEBUG_LLM_OUTBOUND=true — полный промпт генерации документа в лог
  // (проверка анонимизации: реальных ФИО быть не должно).
  if (process.env.DEBUG_LLM_OUTBOUND === 'true') {
    console.log('┏━━━ OUTBOUND PROMPT (document-agent) ━━━\n' + protocolPrompt + '\n┗━━━ END PROMPT ━━━');
  }

  try {
    // Локальная Ollama и облако живут по разным бюджетам вывода: 8192 хватает
    // qwen3, но для облачной reasoning-модели это общий лимит на размышления +
    // JSON, и протокол не помещался (пустой ответ → AI_NoObjectGeneratedError).
    const maxOutputTokens = anonymizeActive
      ? cloudProtocolMaxOutputTokens()
      : ollamaProtocolMaxOutputTokens();
    console.log(
      `[generateFinalDocument] maxOutputTokens=${maxOutputTokens} (${anonymizeActive ? 'cloud' : 'local'})`,
    );
    const streamResult = streamObject({
      model,
      temperature,
      maxOutputTokens,
      schema: ProtocolSchema,
      prompt: protocolPrompt,
      // Размышления выключены ВСЕГДА, а не только в облачном режиме: любая
      // работа с документом от них только теряет время (замер: 12 810 токенов
      // ради 145 символов ответа). Ключ openrouter локальный провайдер игнорирует.
      providerOptions: documentReasoningOptions(),
      ...(abortSignal ? { abortSignal } : {}),
    });

    // ВАЖНО: обработчик к streamResult.object вешаем СРАЗУ, до разбора
    // partialObjectStream. Если провайдер отвалится в самом начале (пустой ответ,
    // 4xx, обрыв), промис `object` отклонится, пока мы ещё читаем partial-поток —
    // без подписчика это unhandledRejection, который на Vercel убивает функцию
    // (FUNCTION_INVOCATION_FAILED → 500 без единого байта ответа клиенту).
    const objectSettled = streamResult.object.then(
      (value) => ({ ok: true as const, value: value as unknown }),
      (error) => ({ ok: false as const, error: error as unknown }),
    );

    let lastMarkdown = '';
    let lastTitle = '';
    // ВАЖНО: панель НЕ очищаем заранее. Раньше здесь стоял data-clear, и старый
    // протокол исчезал сразу, а новый появлялся только после того, как модель
    // закончит думать — замеры на стенде показали пустую панель 3 мин 40 с.
    // Теперь прежняя версия висит до первого куска новой (data-documentSet).
    let sentContent = '';

    const partialStreamError = await consumePartialObjectStream(streamResult.partialObjectStream, async (partial) => {
      const safeProtocol = coerceProtocolPartial(partial);

      let nextMarkdown = '';
      try {
        nextMarkdown = protocolToMarkdown(safeProtocol);
      } catch {
        return;
      }

      if (!nextMarkdown || nextMarkdown === lastMarkdown) return;

      if (safeProtocol.protocolNumber) {
        const nextTitle = `ПРОТОКОЛ ОБСЛЕДОВАНИЯ ${safeProtocol.protocolNumber}`.trim();
        if (nextTitle && nextTitle !== lastTitle) {
          writeData({ type: 'data-title', data: nextTitle, transient: true });
          lastTitle = nextTitle;
        }
      }

      // Первый кусок новой версии заменяет старую целиком одним обновлением
      // (без промежуточного пустого кадра), дальше идут обычные дельты.
      // Если модель перестроила текст — снова полная замена, но опять без clear.
      if (sentContent && nextMarkdown.startsWith(sentContent)) {
        const delta = nextMarkdown.slice(sentContent.length);
        if (delta) {
          writeData({ type: 'data-documentDelta', data: delta, transient: true });
          sentContent = nextMarkdown;
        }
      } else {
        writeData({ type: 'data-documentSet', data: nextMarkdown, transient: true });
        sentContent = nextMarkdown;
      }

      lastMarkdown = nextMarkdown;
      markdownContent = nextMarkdown;
    });
    if (partialStreamError) {
      console.warn(
        '[generateFinalDocument] partial structured stream failed; continuing with final object recovery:',
        partialStreamError,
      );
    }

    let validated: Protocol;
    let rawFinal: unknown;
    const settled = await objectSettled;
    if (settled.ok) {
      rawFinal = settled.value;
    } else {
      const objErr = settled.error;
      logGenerationFailure(objErr);
      const fallbackText = extractNoObjectGeneratedText(objErr);
      const recovered = fallbackText ? parseLooseJsonObject(fallbackText) : null;
      if (recovered) {
        rawFinal = recovered;
        console.warn('[generateFinalDocument] recovered JSON from fenced / non-schema LLM output');
      } else {
        // Пустой ответ модели — ретраим один раз без стриминга: другой роутинг
        // OpenRouter (список запасных слагов) и увеличенный бюджет вывода.
        const retried = await retryProtocolGeneration({
          model,
          prompt: protocolPrompt,
          temperature,
          anonymizeActive,
          abortSignal,
        });
        if (retried) {
          rawFinal = retried;
        } else {
          const raw = String((objErr as any)?.message ?? objErr ?? '');
          if (/no object generated|unexpected end of json input/i.test(raw)) {
            throw new Error(
              'Модель дважды вернула пустой ответ при сборке протокола (перегрузка или лимит бесплатного слага). ' +
                'Повторите генерацию или переключитесь на локальную модель.',
            );
          }
          throw objErr;
        }
      }
    }
    try {
      validated = parseProtocolStrict(rawFinal);
    } catch (validationErr) {
      console.error('[generateFinalDocument] Protocol schema validation failed:', validationErr);
      throw new Error(
        'Итоговый протокол не прошёл проверку структуры (protocol-schema). Сформируйте документ повторно или дополните расшифровку.',
      );
    }

    // Страховка от пустых разделов: если модель вернула пустую повестку/участников/
    // содержание/подписи, добиваем их согласованными в чате блоками. Приоритет у
    // МОДЕЛИ — она видела правки пользователя; чат-драфт заполняет только пустоты
    // (иначе устаревший «подтверждённый» блок откатывал применённые правки).
    validated = mergeProtocolWithChatDraft(validated, chatDraft);

    // Детерминированная зачистка жаргона/разговорных слов перед выводом в документ.
    // Не трогает ФИО и названия организаций — только содержательные поля.
    validated = applyGlossaryToProtocol(validated);

    // Код-гарды: то, в чём слабая модель регулярно ошибается (промптом не лечится).
    validated = stripProtocolTimecodes(validated); // тайм-кодов в финале быть не должно
    validated = carryOverParticipantRoles(validated, conversationContext); // не терять должность
    // Явная правка должности («поменяй должность X на Y») — детерминированно.
    // Промптом не лечится: модель пересобирает все разделы и теряет одну строку,
    // при этом честно рапортуя «документ обновлён» (проверено на стенде).
    {
      const po = applyPositionOverrides(validated, userCorrections);
      validated = po.protocol;
      if (po.applied.length > 0) {
        console.log(
          `[generateFinalDocument] должности по правкам: ${po.applied
            .map((a) => `${a.name} → ${a.position}`)
            .join('; ')}`,
        );
      }
    }
    // Договор/шапку достаём только из ответов пользователя (не из всей расшифровки) —
    // иначе гард ловит случайные упоминания «договор №…» в тексте встречи.
    validated = fillContractFromDialogue(validated, userAnswersText); // не терять договор
    validated = fillHeaderFromDialogue(validated, userAnswersText); // не терять номер/название протокола
    // Выдуманные даты → «подлежит уточнению». Ответы пользователя (userCorrections)
    // привилегированы: названные им даты действительны в любом формате записи
    // («02022025» без точек) и даже при совпадении с датой встречи/договора.
    // Сегодняшняя дата в шапке вместо даты встречи — типовая выдумка модели.
    const meetingDateGuard = dropInventedMeetingDate(validated, conversationContext, userCorrections);
    validated = meetingDateGuard.protocol;
    // «в четверг», «до конца недели» → конкретные даты. Считаем ДО проверки
    // происхождения дат и передаём результат в неё как привилегированные
    // значения: это расчёт кода от известного якоря, а не выдумка модели.
    const relResolved = resolveRelativeDates(validated);
    validated = relResolved.protocol;
    // Даты, которые пользователь назвал ОТНОСИТЕЛЬНО («завтра», «в четверг»),
    // тоже считаются названными им. Без этого происходило вот что: человек
    // просит «срок на завтра», модель верно ставит 29.07.2026, а гард
    // происхождения стирает её как «отсутствующую в расшифровке» — в документе
    // снова «подлежит уточнению», хотя в чате написано, что срок проставлен.
    const userRelativeDates = userCorrections.flatMap((t) =>
      resolveRelativeDatesInText(String(t ?? ''), new Date()).resolutions.map((r) => r.to),
    );
    if (userRelativeDates.length > 0) {
      console.log(
        `[generateFinalDocument] даты из просьб пользователя: ${[...new Set(userRelativeDates)].join(', ')}`,
      );
    }
    const dateGuard = enforceDateProvenance(validated, conversationContext, [
      ...userCorrections,
      ...relResolved.computedDates,
      ...userRelativeDates,
    ]);
    validated = dateGuard.protocol;
    // Что вычислить не удалось («скоро», «в ближайшее время») — под маркер.
    const relFlags = flagRelativeDates(validated);
    validated = relFlags.protocol;
    // Косметика, которую модель делает нестабильно: «№№14», разнобой маркеров,
    // дубли участников в разных падежах.
    validated = normalizeProtocolNumbers(validated);
    validated = unifyUnresolvedMarkers(validated);
    const numberGuard = ensureProtocolNumber(validated);
    validated = numberGuard.protocol;
    const participantsGuard = dedupeParticipants(validated);
    validated = participantsGuard.protocol;
    const guardWarnings = [
      ...relResolved.notes,
      ...(meetingDateGuard.note ? [meetingDateGuard.note] : []),
      ...(numberGuard.note ? [numberGuard.note] : []),
      ...participantsGuard.notes,
      ...relFlags.flags,
      ...new Set([
        ...dateGuard.unresolved,
        ...reconcileWithApproved(validated, chatDraft, userCorrections),
      ]),
    ];

    const finalMarkdown = markUnresolvedInMarkdown(protocolToMarkdown(validated));
    markdownContent = finalMarkdown;
    // Досылаем хвост; если гарды перестроили текст — полная замена без очистки.
    if (finalMarkdown !== sentContent) {
      if (sentContent && finalMarkdown.startsWith(sentContent)) {
        const remaining = finalMarkdown.slice(sentContent.length);
        if (remaining) writeData({ type: 'data-documentDelta', data: remaining, transient: true });
      } else {
        writeData({ type: 'data-documentSet', data: finalMarkdown, transient: true });
      }
    }

    writeData({ type: 'data-finish', data: null, transient: true });

    // Деанонимизация перед DOCX/персистом: облачная модель работала с плейсхолдерами,
    // готовый документ возвращаем пользователю с реальными данными (простая подстановка
    // по mapping). Стрим-дельты деанонимизируются обёрткой на уровне роута.
    let validatedOut = anonymizeActive ? deepDeanonymize(validated, anonMapping) : validated;
    if (anonymizeActive) {
      markdownContent = protocolToMarkdown(validatedOut);
    }

    // Само-ревью протокола локальной моделью: сверяет фактические ошибки
    // (не применённая правка, падежи подстановок, оставшийся плейсхолдер,
    // стенограмма, инфинитивы) и возвращает исправленный протокол. Работает
    // ВСЕГДА с реальными данными (validatedOut уже деанонимизирован) и ВСЕГДА
    // локальной моделью — в облако ничего не уходит. Включается флагом,
    // по умолчанию выключен.
    if (process.env.REVIEW_LOOP_ENABLED === 'true') {
      try {
        const { resolveChatLanguageModel } = await import('@/lib/resolve-chat-model');
        const localModel = resolveChatLanguageModel({ chatProvider: 'ollama' });
        const userRequest = extractLatestUserCorrections(uiMessages || []).join('\n');
        const { reviewAndCorrectProtocol } = await import('./review-loop');
        const before = JSON.stringify(validatedOut);
        validatedOut = await reviewAndCorrectProtocol({
          protocol: validatedOut,
          userRequest,
          model: localModel,
          abortSignal,
        });
        console.log(
          `[review-loop] ${JSON.stringify(validatedOut) === before ? 'без изменений' : 'внесены правки'}`,
        );
        markdownContent = protocolToMarkdown(validatedOut);
      } catch (e) {
        console.warn('[review-loop] пропущено:', (e as Error)?.message);
      }
    }

    // База для будущих точечных правок: сохраняем валидный Protocol JSON с
    // реальными данными. Без него правка = полная пересборка документа.
    if (conversationId) {
      await saveConversationProtocolJson(conversationId, validatedOut)
        .then(() => console.log(`[protocol-patch] база сохранена для диалога ${conversationId}`))
        .catch((e) => console.warn('[protocol-patch] база НЕ сохранена:', (e as Error)?.message));
    }

    const docxBuffer = await generateProtocolDocx(validatedOut);
    const base64Docx = docxBuffer.toString('base64');
    writeData({
      type: 'data-docx',
      data: {
        content: base64Docx,
        filename: `Протокол_обследования_${validatedOut.protocolNumber.replace(/[^0-9]/g, '')}_${validatedOut.meetingDate.replace(/\./g, '-')}.docx`,
      },
    });

    // Финальная сверка (детерминированная): неподтверждённые сроки, расхождения с
    // согласованным в чате, напоминание о поздних правках — показываем в чате.
    if (guardWarnings.length > 0) {
      const warnId = `guard-${Date.now()}`;
      const warnText =
        '⚠️ Финальная сверка протокола (проверьте перед отправкой):\n' +
        guardWarnings.map((w) => `• ${w}`).join('\n');
      dataStream.write({ type: 'text-start', id: warnId });
      dataStream.write({ type: 'text-delta', id: warnId, delta: warnText });
      dataStream.write({ type: 'text-end', id: warnId });
      console.log(`[guards] предупреждений финальной сверки: ${guardWarnings.length}`);
    }

    // Чанкованная верификация — включается через ENABLE_PROTOCOL_VERIFY=true
    if (process.env.ENABLE_PROTOCOL_VERIFY === 'true') {
      try {
        console.log('[verify] Запуск проверки протокола по секциям...');
        const checks = await verifyProtocolSections(validated, conversationContext, model, abortSignal ?? undefined);
        const found = checks.filter((c) => c.hasIssues);
        if (found.length > 0) {
          const warnText =
            `⚠️ Автопроверка нашла возможные несоответствия:\n` +
            found.map((f) => `• ${f.section}: ${f.issues}`).join('\n');
          const warnId = `verify-${Date.now()}`;
          dataStream.write({ type: 'text-start', id: warnId });
          dataStream.write({ type: 'text-delta', id: warnId, delta: warnText });
          dataStream.write({ type: 'text-end', id: warnId });
          console.log(`[verify] Найдено проблем: ${found.length}`);
        } else {
          console.log('[verify] Все секции OK');
        }
      } catch (verifyErr) {
        console.warn('[verify] Проверка не выполнена:', verifyErr);
      }
    }
  } catch (error) {
    console.error('Protocol generation error:', error);
    throw error;
  }

  return markdownContent;
}


/**
 * Разбор AI_NoObjectGeneratedError в лог: без этого в Vercel видно только
 * `usage: [Object]` и непонятно, съели ли бюджет рассуждения.
 */
function logGenerationFailure(err: unknown): void {
  const e = err as any;
  const usage = e?.usage ?? {};
  console.error(
    '[generateFinalDocument] модель не вернула объект:',
    JSON.stringify({
      message: String(e?.message ?? err).slice(0, 200),
      finishReason: e?.finishReason,
      textLength: typeof e?.text === 'string' ? e.text.length : null,
      textPreview: typeof e?.text === 'string' ? e.text.slice(0, 200) : null,
      inputTokens: usage?.inputTokens ?? usage?.promptTokens,
      outputTokens: usage?.outputTokens ?? usage?.completionTokens,
      reasoningTokens: usage?.reasoningTokens,
      totalTokens: usage?.totalTokens,
    }),
  );
}

/**
 * Один повтор генерации без стриминга. Стрим тут не нужен (панель всё равно
 * получит финальный текст), зато меньше движущихся частей: если первая попытка
 * упала на пустом ответе, вторая идёт с запасными слагами OpenRouter.
 */
async function retryProtocolGeneration(options: {
  model: any;
  prompt: string;
  temperature: number;
  anonymizeActive: boolean;
  abortSignal?: AbortSignal;
}): Promise<unknown | null> {
  const { model, prompt, temperature, anonymizeActive, abortSignal } = options;
  console.warn('[generateFinalDocument] повтор генерации протокола (попытка 2/2)');
  try {
    const result = await generateObject({
      model,
      schema: ProtocolSchema,
      prompt,
      temperature,
      maxOutputTokens: anonymizeActive
        ? cloudProtocolMaxOutputTokens()
        : ollamaProtocolMaxOutputTokens(),
      providerOptions: documentReasoningOptions(),
      ...(abortSignal ? { abortSignal } : {}),
    });
    console.log(`[generateFinalDocument] повтор успешен, ${formatUsage((result as any).usage)}`);
    return result.object;
  } catch (err) {
    logGenerationFailure(err);
    const text = extractNoObjectGeneratedText(err);
    const recovered = text ? parseLooseJsonObject(text) : null;
    if (recovered) {
      console.warn('[generateFinalDocument] повтор: JSON восстановлен из сырого текста');
      return recovered;
    }
    return null;
  }
}

/**
 * Показывает, ЧТО именно изменилось, а не первые 70 символов строки.
 * Раньше отчёт выглядел как «Исполнитель выберет оптимальную…» → «Исполнитель
 * выберет оптимальную…»: обрезка съедала различие, и понять правку было нельзя.
 */
function describeEdit(find: string, replace: string): string {
  let start = 0;
  while (start < find.length && start < replace.length && find[start] === replace[start]) start++;
  let end = 0;
  while (
    end < find.length - start &&
    end < replace.length - start &&
    find[find.length - 1 - end] === replace[replace.length - 1 - end]
  ) {
    end++;
  }
  const was = find.slice(start, find.length - end).trim();
  const now = replace.slice(start, replace.length - end).trim();
  if (!was && !now) return `«${find.slice(0, 60)}» — без изменений`;

  const context = find.slice(Math.max(0, start - 30), start).trim();
  const prefix = context ? `…${context} ` : '';
  if (!was) return `${prefix}добавлено «${now}»`;
  if (!now) return `${prefix}удалено «${was}»`;
  return `${prefix}«${was}» → «${now}»`;
}

/** Текст последнего сообщения пользователя — источник правки для patch-режима. */
function lastUserMessageText(uiMessages: any[]): string {
  if (!Array.isArray(uiMessages)) return '';
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const msg = uiMessages[i];
    if (msg?.role !== 'user') continue;
    return stripTimecodeMarkers(extractMessageText(msg)).trim();
  }
  return '';
}

/**
 * Пытается применить правку пользователя точечно, без пересборки протокола.
 * Возвращает markdown (с реальными данными) при успехе или null — тогда
 * вызывающий код идёт обычным путём полной генерации.
 */
async function tryPatchExistingProtocol(options: {
  conversationId?: string | null;
  userRequest: string;
  visibleDocument?: string;
  model: any;
  writeData: (payload: { type: string; data: any; id?: string; transient?: boolean }) => void;
  dataStream: any;
  anonymizeActive: boolean;
  anonMapping: Mapping;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const {
    conversationId,
    userRequest,
    visibleDocument,
    model,
    writeData,
    dataStream,
    anonymizeActive,
    anonMapping,
    abortSignal,
  } = options;

  // Диагностика: без явного лога на КАЖДОМ выходе непонятно, почему патч не
  // сработал — в логах просто нет ни одной строки [protocol-patch].
  if (process.env.PROTOCOL_PATCH_MODE === 'off') {
    console.log('[protocol-patch] выключен через PROTOCOL_PATCH_MODE=off');
    return null;
  }
  if (!conversationId) {
    console.log('[protocol-patch] пропуск: нет conversationId');
    return null;
  }
  if (!userRequest) {
    console.log('[protocol-patch] пропуск: пустое сообщение пользователя');
    return null;
  }

  let base: Protocol;
  try {
    const stored = await getConversationProtocolJson(conversationId);
    if (!stored) {
      console.log(
        `[protocol-patch] пропуск: в диалоге ${conversationId} ещё нет сохранённого document_json (первая генерация) → полная сборка`,
      );
      return null;
    }
    base = parseProtocolStrict(stored);

    // База и открытый у пользователя документ должны совпадать. Если версия в
    // хранилище отстала (предыдущая сборка не сохранилась, документ правили
    // вручную), патч ляжет на СТАРЫЙ текст и вернёт его в панель — правка
    // «исчезнет», а рядом всплывут старые значения. Реальный случай: срок
    // 20.06.2025 из давнего прогона снова оказался в документе.
    // В анон-режиме visibleDocument приходит обезличенным (route.ts делает
    // anonymizeWithMapping перед передачей агенту), а база хранится с реальными
    // данными. Без деобезличивания панели плейсхолдеры короче реальных значений
    // и проверка расходится всегда → патч никогда не применяется.
    const rawVisible = String(visibleDocument ?? '');
    const visible = (anonymizeActive ? deanonymize(rawVisible, anonMapping) : rawVisible).trim();
    if (visible) {
      const baseText = markUnresolvedInMarkdown(protocolToMarkdown(base));
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const a = norm(baseText);
      const b = norm(visible);
      if (a !== b) {
        // Небольшой люфт: рендер панели и markdown могут отличаться мелочами.
        const shorter = Math.min(a.length, b.length);
        const longer = Math.max(a.length, b.length);
        const closeEnough = longer > 0 && shorter / longer > 0.97 && Math.abs(a.length - b.length) < 200;
        if (!closeEnough) {
          console.log(
            `[protocol-patch] сохранённая база разошлась с документом в панели (${a.length} против ${b.length} символов) → полная сборка`,
          );
          return null;
        }
      }
    }

    console.log('[protocol-patch] база найдена и совпадает с панелью, планирую точечные замены');
  } catch (e) {
    console.warn('[protocol-patch] сохранённый протокол не читается:', (e as Error)?.message);
    return null;
  }

  // В облако уходит только обезличенная версия — и документ, и текст правки.
  const baseForModel = anonymizeActive
    ? mapProtocolStrings(base, (s) => applyMappingForward(s, anonMapping))
    : base;
  const requestForModel = anonymizeActive
    ? applyMappingForward(userRequest, anonMapping)
    : userRequest;

  const plan = await planProtocolPatch({
    model,
    // Без markUnresolvedInMarkdown: значок ⚠️ живёт только в отрисовке, в полях
    // JSON его нет. Показав модели текст со значком, мы получали find, который
    // потом не находился, и патч всегда откатывался на полную генерацию.
    documentMarkdown: protocolToMarkdown(baseForModel),
    userRequest: requestForModel,
    abortSignal,
  });

  if (!plan.canPatch || plan.edits.length === 0) {
    console.log(
      `[protocol-patch] точечная правка не подходит (${plan.reason || 'нет замен'}) → полная генерация`,
    );
    return null;
  }

  const applied = applyEditsToProtocol(baseForModel, plan.edits);
  if (!applied.ok) {
    console.log(
      `[protocol-patch] замены не применены (${applied.reason}) → полная генерация`,
      applied.failedEdit ? `find="${applied.failedEdit.find.slice(0, 60)}"` : '',
    );
    return null;
  }

  // Нормализующие гарды. Патч раньше шёл вообще мимо них, и в документ могли
  // попасть вещи, которые полная сборка отфильтровала бы: относительная дата
  // текстом, второй вариант маркера, тайм-код, жаргон, задвоенный «№».
  // Берём только детерминированную косметику — те гарды, что ДОПОЛНЯЮТ данные
  // (fillContractFromDialogue, mergeProtocolWithChatDraft), здесь не нужны:
  // они переписали бы то, что пользователь только что поправил.
  const patchGuardNotes: string[] = [];
  {
    let p = applied.protocol;
    p = stripProtocolTimecodes(p);
    p = applyGlossaryToProtocol(p);
    const rel = resolveRelativeDates(p);
    p = rel.protocol;
    patchGuardNotes.push(...rel.notes);
    const flags = flagRelativeDates(p);
    p = flags.protocol;
    patchGuardNotes.push(...flags.flags);
    p = normalizeProtocolNumbers(p);
    p = unifyUnresolvedMarkers(p);
    applied.protocol = p;
  }

  let patchedOut: Protocol;
  try {
    patchedOut = parseProtocolStrict(
      anonymizeActive ? deepDeanonymize(applied.protocol, anonMapping) : applied.protocol,
    );
  } catch (e) {
    console.warn('[protocol-patch] результат не прошёл схему → полная генерация:', (e as Error)?.message);
    return null;
  }

  console.log(`[protocol-patch] применено замен: ${applied.applied.length} (без пересборки документа)`);

  // В панель отдаём ту же версию, что и при полной генерации: обезличенную —
  // деанонимизацию SSE делает обёртка роута.
  const streamMarkdown = markUnresolvedInMarkdown(protocolToMarkdown(applied.protocol));

  // Сначала — САМИ замены. Клиент применит их к тексту, который уже открыт у
  // пользователя: перерисуется только затронутый фрагмент, документ не мигает
  // и не собирается заново. Затем эталонная версия целиком (без очистки) —
  // страховка на случай, если фрагмент на клиенте не нашёлся.
  writeData({
    type: 'data-documentEdits',
    data: applied.applied.map((e) => ({ find: e.find, replace: e.replace })),
    transient: true,
  });
  writeData({ type: 'data-documentSet', data: streamMarkdown, transient: true });
  writeData({ type: 'data-finish', data: null, transient: true });

  const finalMarkdown = markUnresolvedInMarkdown(protocolToMarkdown(patchedOut));

  try {
    const docxBuffer = await generateProtocolDocx(patchedOut);
    writeData({
      type: 'data-docx',
      data: {
        content: docxBuffer.toString('base64'),
        filename: `Протокол_обследования_${patchedOut.protocolNumber.replace(/[^0-9]/g, '')}_${patchedOut.meetingDate.replace(/\./g, '-')}.docx`,
      },
    });
  } catch (e) {
    console.warn('[protocol-patch] DOCX не собран:', (e as Error)?.message);
  }

  await saveConversationProtocolJson(conversationId, patchedOut).catch(() => {});

  const changed = applied.applied.map((e) => `• ${describeEdit(e.find, e.replace)}`).join('\n');
  // То, что применить не удалось, пользователь должен увидеть — иначе он решит,
  // что учтено всё, а часть мест осталась со старым текстом.
  const allWarnings = [...(applied.warnings ?? []), ...patchGuardNotes];
  const warns = allWarnings.length
    ? `\n\n⚠️ Требует вашего внимания:\n${allWarnings.map((w) => `• ${w}`).join('\n')}`
    : '';
  const noteId = `patch-${Date.now()}`;
  dataStream.write({ type: 'text-start', id: noteId });
  dataStream.write({
    type: 'text-delta',
    id: noteId,
    delta: `Правка внесена точечно, остальной текст протокола не менялся.\n${changed}${warns}`,
  });
  dataStream.write({ type: 'text-end', id: noteId });

  return finalMarkdown;
}

/** Визуально помечает в markdown-панели места, требующие уточнения (просьба заказчика). */
function markUnresolvedInMarkdown(md: string): string {
  return md
    .replace(/требует уточнени[йя]/gi, (m) => `⚠️ ${m}`)
    .replace(/требующ(ий|ая|ее|ие|его|ую)\s+уточнени[яю]/gi, (m) => `⚠️ ${m}`)
    .replace(/подлежит уточнению/gi, '⚠️ подлежит уточнению')
    .replace(/не указано в расшифровке/gi, '⚠️ не указано в расшифровке — требует уточнения')
    .replace(/⚠️\s*⚠️/g, '⚠️')
    // Схлопываем хвосты маркера. Без этого при каждой повторной сборке к строке
    // «не указано в расшифровке — требует уточнения» дописывался ещё один хвост,
    // и после трёх правок получалось «— требует уточнения — ⚠️ требует уточнения
    // — ⚠️ требует уточнения». Учитываем значок между повторами.
    .replace(/(—\s*(?:⚠️\s*)?требует уточнения)(\s*—\s*(?:⚠️\s*)?требует уточнения)+/gi, '$1');
}

/** Проверяет, что название организации — реальное имя, а не заглушка или мусор из LLM. */
function isValidOrgDisplayName(name: string): boolean {
  const s = name.trim();
  if (!s) return false;
  if (/^[-–—\s.]+$/.test(s)) return false;         // только дефисы/тире/точки
  if (/^(заказчик|исполнитель)$/i.test(s)) return false;
  if (s.length > 100) return false;                 // слишком длинно — попал контент встречи
  return true;
}

/** Converts a multiline string to a markdown bullet list. Single-line text is returned as-is. */
function formatMultilineField(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return text;
  return lines.map((l) => `- ${l}`).join('\n');
}

function protocolToMarkdown(protocol: Protocol): string {
  const normalizedNumber = String(protocol.protocolNumber || '').trim().startsWith('№')
    ? String(protocol.protocolNumber).trim()
    : `№${String(protocol.protocolNumber || '').trim()}`;

  let md = `ПРОТОКОЛ ${normalizedNumber} ОТ ${protocol.meetingDate}\n\n`;

  const title = cleanProtocolText(protocol.protocolTitle);
  if (title) md += `**${title}**\n\n`;

  md += `${formatContractBlock(protocol)}\n\n`;
  if (protocol.contractSubject) {
    md += `Тема договора: ${cleanProtocolText(protocol.contractSubject)}\n\n`;
  }

  md += '---\n\n';

  // 1. Дата собрания
  md += formatProtocolSectionHeading(1, `Дата собрания: ${protocol.meetingDate}`);

  // 2. Повестка
  md += formatProtocolSectionHeading(2, 'Повестка:');
  if (protocol.agenda.items.length > 0) {
    protocol.agenda.items.forEach((item, i) => {
      md += `${i + 1}) ${cleanProtocolText(item)};\n`;
    });
  }
  md += '\n\n';

  // 3. Участники
  md += formatProtocolSectionHeading(3, 'Участники:');

  const custOrg = protocol.participants.customer.organizationName.trim();
  md += `**Заказчик${isValidOrgDisplayName(custOrg) ? ` — ${custOrg}` : ''}**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.customer.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => { md += `| ${p.fullName} | ${p.position} |\n`; });

  md += '\n\n';

  const execOrg = protocol.participants.executor.organizationName.trim();
  md += `**Исполнитель${isValidOrgDisplayName(execOrg) ? ` — ${execOrg}` : ''}**\n\n`;
  md += '| ФИО | Должность |\n';
  md += '| --- | --- |\n';
  protocol.participants.executor.people
    .filter((p) => isValidParticipantRow(p.fullName, p.position))
    .forEach((p) => { md += `| ${p.fullName} | ${p.position} |\n`; });

  md += '\n\n';

  // 4. Содержание встречи
  md += formatProtocolSectionHeading(4, 'Содержание встречи:');
  protocol.meetingContent.topics.forEach((topic, i) => {
    md += `**${i + 1}) ${cleanProtocolText(topic.title)}**\n\n`;
    const listened = cleanProtocolText(topic.listened);
    const discussed = cleanProtocolText(topic.discussed);
    const decided = cleanProtocolText(topic.decided);
    if (listened) md += `**Слушали:** ${listened}\n\n`;
    if (discussed) md += `**Обсудили:**\n\n${formatMultilineField(discussed)}\n\n`;
    if (decided) md += `**Решили:**\n\n${formatMultilineField(decided)}\n\n`;
  });

  if (protocol.meetingContent.summary.length > 0) {
    md += '**Резюме:**\n\n';
    md += '| **Обсуждаемые вопросы** | **Принятые решения** |\n';
    md += '| --- | --- |\n';
    protocol.meetingContent.summary.forEach((row) => {
      const q = cleanProtocolText(row.question);
      const d = formatSummaryDecisionForMarkdown(row.decision);
      if (q || d) md += `| ${q} | ${d} |\n`;
    });
    md += '\n';
  }

  md += '\n\n';

  // 5. Согласовано — двухколоночная таблица
  md += formatProtocolSectionHeading(5, 'Согласовано:');

  const approval = resolveApprovalForDocument(protocol);
  const formatApprOrg = (org: string) => {
    const t = org.trim();
    if (!t || /^(заказчик|исполнитель)$/i.test(t)) return 'не указано в расшифровке';
    if (/^ООО\s/i.test(t)) return `${t}:`;
    const inner = t.replace(/^ООО\s*[«"'„](.+?)[»"'"]$/, '$1').trim();
    if (inner !== t) return `ООО «${inner}»:`;
    return `${t}:`;
  };

  const custSigs = approval.customer.signatories;
  const execSigs = approval.executor.signatories;
  const sigLen = Math.max(custSigs.length, execSigs.length, 1);

  md += `| **Со стороны Заказчика** | **Со стороны Исполнителя** |\n`;
  md += `| --- | --- |\n`;
  md += `| ${formatApprOrg(approval.customer.organization)} | ${formatApprOrg(approval.executor.organization)} |\n`;

  for (let i = 0; i < sigLen; i++) {
    const cust = custSigs[i] ? `${custSigs[i].trim()} /______________` : '______________________';
    const exec = execSigs[i] ? `${execSigs[i].trim()} /______________` : '______________________';
    md += `| ${cust} | ${exec} |\n`;
  }
  md += '\n';

  return md;
}
