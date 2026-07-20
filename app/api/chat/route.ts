import {
  convertToModelMessages,
} from 'ai';
import crypto from 'crypto';
import { getPrompt, updatePrompt, createPromptForUser, getUserSelectedPrompt, getPromptById, saveConversation, updateConversation } from '@/lib/getPromt';
import { resolveChatLanguageModel } from '@/lib/resolve-chat-model';
import { normalizeCloudModel } from '@/lib/chat-models';
import { PROTOCOL_CHAT_TIMECODE_APPENDIX } from '@/lib/protocol-timecodes';
import { analyzeTranscriptSlots, formatSlotScanForPrompt } from '@/lib/protocol-slot-scan';
import { fetchRagSnippet } from '@/lib/rag-client';
import {
  buildUserProvidedSection1Appendix,
  userProvidedSection1InTranscript,
} from '@/lib/protocol-user-facts';
import {
  fallbackRagQuestion,
  hydratedChatTranscriptForRag,
  stripTextForRagQuery,
} from '@/lib/rag-search-query';
import { runMainAgent } from './agents/main-agent';
import {
  generateRagSearchQueryLine,
  RAG_AUTO_PURPOSE_FOCUS,
  RAG_TOOL_MODE_SYSTEM_APPENDIX,
} from './agents/rag-tools';
import { AgentContext } from './agents/types';
import {
  anonymizeNewText,
  anonymizeWithMapping,
  loadConversationMapping,
  countersFromMapping,
  scrubStructured,
  scrubSensitiveOrgs,
  restoreNonSensitivePlaceholders,
  persistConversationMapping,
  AnonymizerUnavailableError,
  type Mapping,
  type ConversationMapping,
} from '@/lib/anonymization';
import {
  wrapResponseWithDeanonymization,
  prependNoticeToResponse,
} from '@/lib/anonymization/sse-deanonymize';
import { ANONYMIZE_MODE_SYSTEM_APPENDIX } from '@/lib/anonymization/prompt';

// Должно быть ≥ таймаута прокси/Ollama для длинных ответов (300s совпадало с 5m и обрывом стрима).
export const maxDuration = 300;
export const runtime = 'nodejs';

let cachedPrompt: string | null = null;

function buildSystemPrompt(
  userPrompt: string,
  hiddenDocsContext?: string,
  ragContext?: string,
  ragOmitsAttachmentBodies?: boolean
): string {
  const ragBlock = ragContext?.trim()
    ? `
===== КОНТЕКСТ ИЗ RAG (ФРАГМЕНТЫ ИЗ ИНДЕКСА ДОКУМЕНТОВ) =====
${ragContext.trim()}
ИНСТРУКЦИЯ: опирайся на этот контекст для фактов из загруженных в RAG документов; если данных нет — так и скажи.${
      ragOmitsAttachmentBodies
        ? ' Тексты прикреплённых файлов в этот запрос не подставлялись (только имена); факты из документов бери из этого блока.'
        : ''
    }
===== КОНЕЦ КОНТЕКСТА RAG =====
`
    : '';

  return `
${ragBlock}
===== ВЛОЖЕНИЯ ПОЛЬЗОВАТЕЛЯ (КОНТЕКСТ) =====
${hiddenDocsContext}

ИНСТРУКЦИЯ ПО РАБОТЕ С ВЛОЖЕНИЯМИ:
1. Это справочные материалы. НЕ делай их краткий пересказ (summary), если пользователь об этом явно не попросил.
2. Используй информацию из них только для ответов на конкретные вопросы или выполнения задач пользователя.
3. Если пользователь не задал вопрос, просто подтверди получение файлов и скажи, что готов работать с ними согласно твоей основной инструкции.${
      ragOmitsAttachmentBodies
        ? '\n4. Режим RAG: ниже могут быть только имена файлов без полного текста — опирайся на блок RAG выше.'
        : ''
    }
${ragOmitsAttachmentBodies ? '5.' : '4.'} Если ниже полная расшифровка (строки «Спикер N:» и «ЧЧ:ММ:СС — текст») — диалог уже начался: не представляйся; сразу раздел 1; в чате у каждого факта — [ТС: ЧЧ:ММ:СС] из соответствующей строки расшифровки.
===== КОНЕЦ ВЛОЖЕНИЙ =====`;
}

/** Убираем служебные вставки про вложения — чтобы отличить «только файл» от полноценного текста. */
function stripAttachmentPlaceholdersFromUserText(content: string): string {
  let s = String(content ?? '')
    .replace(HIDDEN_RE, '')
    .trim();
  s = s
    .replace(/\n\n\[Файл «[^»]+»[^\]]*\]/g, '')
    .replace(/\n\n\[Вложение «[^»]+»[^\]]*\]/g, '')
    .replace(/\[RAG\][^\n]*/g, '')
    .trim();
  return s;
}

function collectUserAttachmentFilenames(msg: any): string[] {
  const names: string[] = [];
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  for (const p of parts) {
    if (p?.type === 'file' && (p.filename || p.name)) {
      names.push(String(p.filename || p.name));
    }
  }
  const atts = Array.isArray(msg?.metadata?.attachments) ? msg.metadata.attachments : [];
  for (const a of atts) {
    if (a?.name || a?.filename) names.push(String(a.name || a.filename));
  }
  return [...new Set(names.filter(Boolean))];
}

/**
 * Если пользователь прислал вложение(я) почти без текста — первый ответ без «Здравствуйте»,
 * сразу с подтверждением по шаблону из продукта.
 */
/** Полная расшифровка уже в системном блоке (не режим «только RAG»). */
function hasSubstantialInlineTranscript(
  hiddenDocsFull: string[],
  hiddenDocsContext: string,
): boolean {
  const fullChars = hiddenDocsFull.reduce((s, d) => s + d.length, 0);
  if (fullChars >= 4000) return true;
  return hiddenDocsContext.trim().length >= 8000;
}

function buildFileOnlyTurnAppendix(
  lastUserMessage: any,
  options?: { protocolTranscriptReady?: boolean },
): string {
  if (options?.protocolTranscriptReady) return '';
  if (!lastUserMessage || lastUserMessage.role !== 'user') return '';
  const filenames = collectUserAttachmentFilenames(lastUserMessage);
  if (filenames.length === 0) return '';
  const raw =
    typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '';
  const visible = stripAttachmentPlaceholdersFromUserText(raw);
  if (visible.length > 16) return '';

  const quoted = filenames.map((n) => `«${n}»`).join(', ');
  const one = filenames.length === 1;
  const requiredOpening = one
    ? `Получен файл ${quoted}. Готов работать с ним согласно инструкции — отвечать на конкретные вопросы или выполнять задачи, связанные с его содержимым. Скажите, что именно вам нужно?`
    : `Получены файлы ${quoted}. Готов работать с ними согласно инструкции — отвечать на конкретные вопросы или выполнять задачи, связанные с их содержимым. Скажите, что именно вам нужно?`;

  return `

===== ОСОБЫЙ СЛУЧАЙ: ТОЛЬКО ВЛОЖЕНИЕ(Я), БЕЗ ТЕКСТА ЗАДАЧИ =====
Последнее сообщение пользователя: вложение(я) без содержательного запроса (без приветствия и без вопроса).

Твой **первый** ответ в этом ходу должен **начинаться сразу** с **точно** такого текста (без «Здравствуйте», без любых вступлений **перед** этим абзацем):

${requiredOpening}

После этого абзаца при необходимости добавь не больше одного короткого предложения.
===== КОНЕЦ ОСОБОГО СЛУЧАЯ =====
`;
}

async function resolveSystemPrompt(userId?: string | null, selectedPromptId?: string | null): Promise<string> {
  if (selectedPromptId) {
    try {
      const prompt = await getPromptById(selectedPromptId);
      if (prompt?.content) return prompt.content;
    } catch (error) {
      console.error('Failed to load selected prompt:', error);
    }
  }

  if (userId) {
    try {
      const selectedId = await getUserSelectedPrompt(userId);
      if (selectedId) {
        const prompt = await getPromptById(selectedId);
        if (prompt?.content) return prompt.content;
      }
    } catch (error) {
      console.error('Failed to load user prompt, falling back to default:', error);
    }
  }

  if (!cachedPrompt) cachedPrompt = await getPrompt();
  return cachedPrompt;
}

// === FILE PARSING UTILS ===
const HIDDEN_RE = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;
const HIDDEN_CAPTURE_RE = /<AI-HIDDEN>[\s\S]*?<\/AI-HIDDEN>/gi;

async function urlToBuffer(urlOrData?: string | null): Promise<Buffer | null> {
  if (!urlOrData) return null;

  // ── Base64 data URL ──────────────────────────────────────────────────────
  if (urlOrData.startsWith('data:')) {
    const match = String(urlOrData).match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) return null;
    try {
      return Buffer.from(match[1], 'base64');
    } catch {
      return null;
    }
  }

  // ── HTTPS / HTTP URL (e.g. Vercel Blob) ─────────────────────────────────
  if (urlOrData.startsWith('https://') || urlOrData.startsWith('http://')) {
    try {
      const resp = await fetch(urlOrData);
      if (!resp.ok) {
        console.warn('[urlToBuffer] Fetch failed:', resp.status, urlOrData);
        return null;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (err) {
      console.warn('[urlToBuffer] Fetch error:', err);
      return null;
    }
  }

  return null;
}

function guessFileExt(att: any): string {
  const name = String(att?.name || att?.filename || '').trim();
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  return (m?.[1] ?? '').toLowerCase();
}

function bestEffortBinaryText(buf: Buffer): string | null {
  if (!buf || buf.length < 8) return null;

  const candidates: string[] = [];
  try {
    candidates.push(buf.toString('utf8'));
  } catch {}
  try {
    candidates.push(buf.toString('utf16le'));
  } catch {}
  try {
    candidates.push(buf.toString('latin1'));
  } catch {}

  const clean = (raw: string) =>
    String(raw ?? '')
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]+/g, ' ')
      .replace(/\u0000+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

  // Keep long-ish runs of readable characters (Latin/Cyrillic/digits/punct)
  const extractReadableRuns = (text: string) => {
    const runs = text.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\s.,:;!?()\[\]"'«»\-–—\/\\]{40,}/g);
    if (!runs?.length) return '';
    return runs.map((r) => clean(r)).filter(Boolean).join('\n');
  };

  let best = '';
  for (const c of candidates) {
    const runs = extractReadableRuns(c);
    if (runs.length > best.length) best = runs;
  }

  const cleaned = clean(best);
  return cleaned.length >= 40 ? cleaned : null;
}

async function extractPdfTextFromAttachment(att: any): Promise<string | null> {
  if (!att || att.mediaType !== 'application/pdf') return null;
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;
  try {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(buf);
    return parsed?.text?.trim() || null;
  } catch (error) {
    console.error('Failed to parse PDF attachment:', error);
    return null;
  }
}

async function extractLegacyDoc(buf: Buffer): Promise<string | null> {
  try {
    const WordExtractor = (await import('word-extractor')).default;
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buf);
    const text = doc.getBody()?.trim();
    return text || null;
  } catch (error) {
    console.error('word-extractor parse failed:', error);
    return null;
  }
}

async function extractDocText(att: any): Promise<string | null> {
  const mt = att?.mediaType || att?.mimeType || '';
  const isDocx = mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const buf = await urlToBuffer(att?.url || att?.data);
  if (!buf) return null;

  if (isDocx) {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      const cleaned = result.value.trim();
      if (cleaned) return cleaned;
    } catch (error) {
      console.error('Failed to parse DOCX via mammoth:', error);
    }
  }

  // Legacy DOC: use word-extractor, then best-effort binary text
  const extracted = await extractLegacyDoc(buf);
  if (extracted?.trim()) return extracted.trim();
  return bestEffortBinaryText(buf);
}

async function extractXlsxTextFromAttachment(att: any): Promise<string | null> {
  // Поддерживаем XLSX и старые XLS (application/vnd.ms-excel)
  if (!att) return null;
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;
  try {
    const XLSX = await import('xlsx');
    // xlsx library supports both .xlsx and legacy .xls formats
    const workbook = XLSX.read(buf, { type: 'buffer' });
    let text = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      text += `Sheet: ${sheetName}\n`;
      text += XLSX.utils.sheet_to_txt(sheet);
      text += '\n\n';
    });
    const cleaned = text.trim();
    if (cleaned) return cleaned;
  } catch (error) {
    console.error('Failed to parse Excel attachment:', error);
  }
  return bestEffortBinaryText(buf);
}

async function extractPptxTextFromAttachment(att: any): Promise<string | null> {
  // Поддерживаем PPTX и best-effort для PPT (application/vnd.ms-powerpoint)
  if (!att) return null;
  const mt = att.mediaType || att.mimeType;
  const isPptx = mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const isPpt = mt === 'application/vnd.ms-powerpoint';
  const buf = await urlToBuffer(att.url || att.data);
  if (!buf) return null;

  if (isPptx) {
    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(buf);
      const slideFiles = Object.keys(zip.files).filter(name => name.match(/^ppt\/slides\/slide\d+\.xml$/));
      slideFiles.sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml$/)?.[1] || '0');
        const numB = parseInt(b.match(/slide(\d+)\.xml$/)?.[1] || '0');
        return numA - numB;
      });

      let text = '';
      for (const fileName of slideFiles) {
        const content = await zip.file(fileName)?.async('string');
        if (content) {
          const slideText = content.match(/<a:t>(.*?)<\/a:t>/g)
            ?.map(t => t.replace(/<\/?a:t>/g, ''))
            .join(' ') || '';
          if (slideText.trim()) {
            text += `Slide ${fileName.match(/slide(\d+)\.xml$/)?.[1]}:\n${slideText}\n\n`;
          }
        }
      }
      const cleaned = text.trim();
      if (cleaned) return cleaned;
    } catch (error) {
      console.error('Failed to parse PPTX attachment:', error);
    }
  }

  // Legacy PPT: best-effort binary text extraction
  return bestEffortBinaryText(buf);
}

/** Дефолт 128k (как у qwen3.5:9b на ollama.com). */
const DEFAULT_OLLAMA_CONTEXT_TOKENS = 131072;

/** qwen3:14b в GGUF часто n_ctx_train≈40960 — Ollama не поднимет 128k. */
function effectiveOllamaContextTokens(modelId: string): number {
  const configured = Number(
    process.env.OLLAMA_CONTEXT_LENGTH ?? DEFAULT_OLLAMA_CONTEXT_TOKENS,
  );
  if (!modelId) return configured;
  const id = modelId.toLowerCase();
  if (id.includes('qwen3.5:9b') || id.includes('qwen3.5-9b')) return configured;
  if (id.includes('14b') && id.includes('qwen')) {
    return Math.min(configured, 40960);
  }
  return configured;
}

// === MAIN HANDLER ===

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  let { messages, newSystemPrompt, userId, selectedPromptId, documentContent, useRagContext, ragMode } =
    body as any;
  const anonymizeMode = Boolean((body as any)?.anonymize);
  let conversationId: string | null = null;

  try {
    const url = new URL(req.url);
    conversationId = body.conversationId || url.searchParams.get('conversationId');
    if (!selectedPromptId) selectedPromptId = url.searchParams.get('selectedPromptId');
    const qp = url.searchParams.get('userId');
    if (!userId && qp) userId = qp;
  } catch {}

  if (!Array.isArray(messages)) {
    console.log('⚠️ Messages is not an array, defaulting to empty:', typeof messages);
    messages = [];
  }

  const sender = userId ? `user:${userId}` : 'anon';
  const clientIp =
    req.headers.get('x-forwarded-for') ||
    req.headers.get('x-real-ip') ||
    'unknown';

  console.log(`📨 chat req: msgs=${messages.length} user=${userId || 'anon'} conv=${conversationId || 'none'} doc=${!!documentContent}`);

  // 1. Handle System Prompt Updates
  if (newSystemPrompt) {
    try {
      if (userId) {
        const title = (newSystemPrompt || '').slice(0, 60) || 'User Prompt';
        await createPromptForUser(userId, title, newSystemPrompt);
      } else {
        await updatePrompt(newSystemPrompt);
      }
      cachedPrompt = newSystemPrompt;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (err) {
      console.error('Error saving prompt for user:', err);
      return new Response(JSON.stringify({ success: false }), { status: 500 });
    }
  }

  // 2. Normalize Messages & Extract Attachments
  const toPlainText = (msg: any): string => {
    if (Array.isArray(msg.parts)) {
      const textPart = msg.parts.find((p: any) => p?.type === 'text' && typeof p.text === 'string');
      if (textPart?.text) return String(textPart.text);
    }
    if (typeof msg.content === 'string') return msg.content;
    return '';
  };

  let baseMessages: any[] = Array.isArray(messages) && messages.length > 0
    ? messages
    : (body && (body.text || body.message)
      ? [{
          id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
          role: 'user',
          parts: [{ type: 'text', text: String(body.text ?? body.message ?? '') }],
          content: String(body.text ?? body.message ?? ''),
        }]
      : []);

  const inboundFiles: any[] = Array.isArray((body as any)?.files)
    ? (body as any).files
    : Array.isArray((body as any)?.message?.files)
      ? (body as any).message.files
      : [];

  if (inboundFiles.length > 0) {
    const fileParts = inboundFiles
      .map((file: any) => {
        const url = file?.url || file?.data || '';
        if (!url) return null;
        return {
          type: 'file',
          id: file?.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
          filename: file?.filename || file?.name || 'attachment',
          url,
          mediaType: file?.mediaType || file?.mimeType || file?.type,
        };
      })
      .filter(Boolean);

    if (fileParts.length > 0) {
      if (!Array.isArray(baseMessages) || baseMessages.length === 0) {
        baseMessages = [{
          id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
          role: 'user',
          parts: fileParts,
          content: '',
        }];
      } else {
        const lastIdx = [...baseMessages].map((m, i) => ({ m, i })).reverse().find(({ m }) => m?.role === 'user')?.i ?? -1;
        if (lastIdx >= 0) {
          const last = baseMessages[lastIdx];
          const existingFiles = Array.isArray(last?.parts)
            ? last.parts.filter((p: any) => p?.type === 'file')
            : [];
          if (existingFiles.length === 0) {
            last.parts = Array.isArray(last?.parts) ? [...last.parts, ...fileParts] : [...fileParts];
            if (typeof last.content !== 'string') last.content = '';
          }
        }
      }
    }
  }

  // base messages count — verbose log removed

  const normalizedMessages: any[] = baseMessages.map((m: any) => {
    const rawText = toPlainText(m);
    const hiddenMatches = rawText.match(HIDDEN_CAPTURE_RE) || [];
    const hiddenTexts = hiddenMatches
      .map((segment) => segment.replace(/<AI-HIDDEN>/gi, '').replace(/<\/AI-HIDDEN>/gi, '').trim())
      .filter(Boolean);

    const visibleText = rawText.replace(HIDDEN_RE, '').trim();
    const fileParts = Array.isArray(m?.parts) ? m.parts.filter((p: any) => p?.type === 'file') : [];
    
    const attachmentsFromParts = fileParts.map((file: any) => {
        const url = file?.url || file?.data || '';
        if (!url) return null;
        return {
          id: file.id || crypto.randomUUID(),
          name: file.filename || 'attachment',
          url,
          mediaType: file.mediaType || file.mimeType,
        };
      }).filter(Boolean);

    const attachmentsFromMeta = Array.isArray(m?.metadata?.attachments)
      ? m.metadata.attachments
      : [];

    const attachments = [...attachmentsFromMeta, ...attachmentsFromParts];
    const attachmentsText = attachments
      .map((att: any) => {
        const name = att?.name ? String(att.name) : 'attachment';
        const content = att?.content ? String(att.content) : '';
        return content ? `Файл: ${name}\n${content}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    const combined = [visibleText, attachmentsText].filter(Boolean).join('\n\n');

    return {
      id: m.id || crypto.randomUUID(),
      role: ['assistant', 'user', 'system', 'tool'].includes(m.role) ? m.role : 'user',
      content: combined,
      parts: [{ type: 'text' as const, text: combined }],
      metadata: { ...(m.metadata || {}), attachments, hiddenTexts },
    };
  });

  // Drop completely empty messages to avoid provider errors (content/parts must exist)
  const normalizedMessagesNonEmpty = normalizedMessages.filter((m) => {
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    const hasFileParts = Array.isArray(m?.parts) && m.parts.some((p: any) => p?.type === 'file');
    const hasAttachments = Array.isArray(m?.metadata?.attachments) && m.metadata.attachments.length > 0;
    return Boolean(text) || hasFileParts || hasAttachments;
  });

  if (normalizedMessages.length !== normalizedMessagesNonEmpty.length) {
    console.warn('Filtered empty messages:', normalizedMessages.length - normalizedMessagesNonEmpty.length);
  }

  // normalized count — verbose log removed

  const ragOmitsAttachmentBodies = Boolean(useRagContext);

  // 3. Process Attachments
  for (const msg of normalizedMessagesNonEmpty) {
    const atts: any[] = Array.isArray(msg?.metadata?.attachments) ? msg.metadata.attachments : [];
    if (!atts.length) continue;

    const collected: string[] = [];

    if (ragOmitsAttachmentBodies) {
      for (const att of atts) {
        const name = att?.name || att?.filename || 'документ';
        collected.push(
          `[RAG] Файл «${name}» — полный текст в промпт не передаётся; факты из документа используй из блока «КОНТЕКСТ ИЗ RAG» в системном сообщении.`
        );
      }
    } else {
      for (const att of atts) {
        const name = att?.name || att?.filename || 'документ';
        const mt = att?.mediaType || att?.mimeType || 'unknown';
        const ext = guessFileExt(att);
        let extracted: string | null = null;

        try {
          if (mt === 'application/pdf') {
            extracted = await extractPdfTextFromAttachment(att);
          } else if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mt === 'application/msword') {
            extracted = await extractDocText(att);
          } else if (mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mt === 'application/vnd.ms-excel') {
            extracted = await extractXlsxTextFromAttachment(att);
          } else if (mt === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mt === 'application/vnd.ms-powerpoint') {
            extracted = await extractPptxTextFromAttachment(att);
          } else if (ext === 'doc' || ext === 'docx') {
            extracted = await extractDocText(att);
          } else if (ext === 'xls' || ext === 'xlsx') {
            extracted = await extractXlsxTextFromAttachment(att);
          } else if (ext === 'ppt' || ext === 'pptx') {
            extracted = await extractPptxTextFromAttachment(att);
          }
        } catch (err) {
          console.error('Failed to parse attachment', name, mt, err);
        }

        if (extracted && extracted.trim()) {
          collected.push(extracted.trim());
        } else {
          collected.push(`Файл "${name}": текст не извлечён (тип ${mt}).`);
        }
      }
    }

    if (collected.length) {
      msg.metadata = {
        ...(msg.metadata || {}),
        attachments: atts,
        hiddenTexts: [...(msg.metadata?.hiddenTexts || []), ...collected],
      };
    }
  }

  // 4. Prepare Context for Agents
  const userPrompt = await resolveSystemPrompt(userId, selectedPromptId);

  /**
   * Полное тело вложения — только если сообщение с файлом находится в последних
   * MAX_DOC_FRESHNESS_MSGS сообщениях. Иначе — краткая сноска «файл получен».
   * Это предотвращает переполнение контекста при длинных диалогах с большими документами.
   */
  // 0 = документ сразу идёт в системный блок (не в историю сообщений).
  // Это оптимально: история всегда компактна, документ всегда доступен модели.
  const MAX_DOC_FRESHNESS_MSGS = 0;
  let lastUserWithAttachmentsIndex = -1;
  if (!ragOmitsAttachmentBodies) {
    const cutoff = normalizedMessagesNonEmpty.length - MAX_DOC_FRESHNESS_MSGS;
    for (let i = normalizedMessagesNonEmpty.length - 1; i >= 0; i--) {
      const m = normalizedMessagesNonEmpty[i];
      if (m?.role !== 'user') continue;
      const ht = Array.isArray((m as any)?.metadata?.hiddenTexts) ? (m as any).metadata.hiddenTexts : [];
      if (ht.length > 0) {
        // Если вложение слишком старое — не включать полный текст (только ссылку)
        lastUserWithAttachmentsIndex = i >= cutoff ? i : -1;
        break;
      }
    }
  }

  // Prepare hidden docs context and enrich messages with file content
  const hiddenDocsFull: string[] = [];  // полные тексты для системного блока
  const messagesWithHidden: any[] = [];
  const DOC_MARKER = '---\nВложенный файл:'; // сохраняем маркер для совместимости

  normalizedMessagesNonEmpty.forEach((msg) => {
    const hiddenTexts: string[] = Array.isArray((msg as any)?.metadata?.hiddenTexts)
      ? (msg as any).metadata.hiddenTexts
      : [];
    const attachmentsMeta: any[] = Array.isArray((msg as any)?.metadata?.attachments)
      ? (msg as any).metadata.attachments
      : [];

    hiddenTexts.forEach((hidden, attIdx) => {
      const cleaned = String(hidden ?? '').trim();
      if (!cleaned) return;
      const attName = attachmentsMeta[attIdx]?.name || attachmentsMeta[attIdx]?.filename;
      const label = attName ? `Документ "${attName}"` : `Документ ${hiddenDocsFull.length + 1}`;

      if (ragOmitsAttachmentBodies) {
        hiddenDocsFull.push(`${label}: [только имя; полный текст не передаётся (включён контекст из RAG)]`);
      } else {
        // Полный текст документа идёт в системный блок
        hiddenDocsFull.push(`${label}:\n${cleaned}`);
      }
    });

    if (hiddenTexts.length > 0) {
      // В user-сообщении оставляем только плейсхолдер — полный текст в системном блоке
      const placeholders = hiddenTexts
        .map((hidden, attIdx) => {
          const cleaned = String(hidden ?? '').trim();
          if (!cleaned) return '';
          const name = attachmentsMeta[attIdx]?.name || attachmentsMeta[attIdx]?.filename || 'документ';
          return `\n\n[Файл «${name}» (${cleaned.length} симв.) прикреплён — полный текст в системном блоке.]`;
        })
        .filter(Boolean)
        .join('');
      const enrichedContent = `${msg.content}${placeholders}`;
      messagesWithHidden.push({
        ...msg,
        content: enrichedContent,
        parts: [{ type: 'text' as const, text: enrichedContent }],
      });
    } else {
      // Qwen3 best practice: удалять <think>...</think> из истории ассистента.
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('<think>')) {
        const stripped = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        messagesWithHidden.push({
          ...msg,
          content: stripped,
          parts: [{ type: 'text' as const, text: stripped }],
        });
      } else {
        messagesWithHidden.push(msg);
      }
    }
  });

  const chatModelId =
    typeof body.chatModel === 'string' ? body.chatModel.trim() : '';
  const contextTokensLimit = effectiveOllamaContextTokens(chatModelId);
  const CHARS_PER_TOKEN = 2.34; // для русского текста; EN ≈ 4
  const RESERVE_RESPONSE_TOKENS = Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS ?? 8192);
  const RESERVE_SYSTEM_BASE_TOKENS = 9000; // системный промт (SGR + полный документ)
  // Системный блок: полные тексты документов
  let hiddenDocsContext = hiddenDocsFull.join('\n\n');

  /**
   * Жёсткий кап документа в системном блоке: сервер Ollama за прокси реально держит
   * num_ctx = OLLAMA_CONTEXT_LENGTH и при переполнении МОЛЧА отрезает НАЧАЛО промпта
   * (в т.ч. системные инструкции). Бюджетная математика истории ниже не спасает от
   * гигантской расшифровки — режем документ заранее, оставляя минимум под историю.
   */
  const RESERVE_HISTORY_MIN_TOKENS = 16000;
  const maxDocChars = Math.max(
    (contextTokensLimit -
      RESERVE_RESPONSE_TOKENS -
      RESERVE_SYSTEM_BASE_TOKENS -
      RESERVE_HISTORY_MIN_TOKENS) *
      CHARS_PER_TOKEN,
    20000,
  );
  if (hiddenDocsContext.length > maxDocChars) {
    const originalLength = hiddenDocsContext.length;
    const truncated = hiddenDocsContext.slice(0, maxDocChars);
    hiddenDocsContext = `${truncated}\n…[РАСШИФРОВКА ОБРЕЗАНА: документ превышает контекстное окно модели (сохранены первые ${Math.floor(maxDocChars)} из ${originalLength} символов). Уточните детали конца встречи у пользователя.]…`;
    console.warn(
      `[route] hiddenDocsContext обрезан: ${originalLength} → ${Math.floor(maxDocChars)} симв. (~${Math.ceil(maxDocChars / CHARS_PER_TOKEN)} токенов)`,
    );
  }

  /**
   * Динамическая обрезка истории — гарантирует, что диалог любой длины не вызовет переполнения.
   *
   * Алгоритм:
   *  1. Оцениваем бюджет: контекст − ответ − системный промпт (без документа).
   *  2. Если история превышает бюджет — удаляем старые сообщения, пропуская сообщения с документами.
   *  3. Добавляем системное уведомление об усечении.
   *
   * Документы ВСЕГДА остаются в user-сообщениях — никогда не вырезаются при тримминге.
   */
  const CONTEXT_TOKENS_LIMIT = contextTokensLimit;
  const docTokensEstimate = Math.ceil(hiddenDocsContext.length / CHARS_PER_TOKEN);
  const availableForHistoryTokens =
    CONTEXT_TOKENS_LIMIT - RESERVE_RESPONSE_TOKENS - RESERVE_SYSTEM_BASE_TOKENS - docTokensEstimate;
  const availableForHistoryChars = Math.max(availableForHistoryTokens * CHARS_PER_TOKEN, 8000);

  function msgChars(m: any): number {
    if (typeof m?.content === 'string') return m.content.length;
    return JSON.stringify(m?.content ?? '').length;
  }
  const isDocMsg = (m: any) =>
    typeof m?.content === 'string' && m.content.includes(DOC_MARKER);

  let finalMessages = messagesWithHidden;
  const totalHistoryChars = finalMessages.reduce((s, m) => s + msgChars(m), 0);

  if (totalHistoryChars > availableForHistoryChars && finalMessages.length > 2) {
    let trimCount = 0;
    while (
      finalMessages.length > 2 &&
      finalMessages.reduce((s, m) => s + msgChars(m), 0) > availableForHistoryChars
    ) {
      // Пропускаем сообщения с документами — они защищены от удаления
      const trimIdx = finalMessages.findIndex(
        (m, idx) => idx < finalMessages.length - 2 && !isDocMsg(m),
      );
      if (trimIdx === -1) break;
      finalMessages = [...finalMessages.slice(0, trimIdx), ...finalMessages.slice(trimIdx + 1)];
      trimCount++;
    }
    if (trimCount > 0) {
      const notice = {
        role: 'system' as const,
        content: `[Контекст: ${trimCount} ранних сообщений диалога удалены для предотвращения переполнения окна. Прикреплённые документы сохранены в истории.]`,
        id: '__trim_notice__',
        parts: [{ type: 'text' as const, text: '' }],
      };
      finalMessages = [notice, ...finalMessages];
      const usedChars = finalMessages.reduce((s, m) => s + msgChars(m), 0);
      console.log(`✂️  history trimmed: removed ${trimCount} msgs, history≈${Math.round(usedChars/CHARS_PER_TOKEN)}tok, budget=${availableForHistoryTokens}tok`);
    }
  }

  // ===== Режим «Облако + анонимизация» (152-ФЗ) =====
  // Документ и сообщения чистим от ПДн ПЕРЕД отправкой в облачную LLM. Сервер
  // дёргаем только для НОВОГО текста (последнее сообщение пользователя; документ —
  // если mapping ещё пуст, т.е. preview не выполнялся). Остальное переписываем
  // локально по каноническому mapping диалога.
  let effectiveProvider: string | undefined = (body as Record<string, unknown>).chatProvider as
    | string
    | undefined;
  let effectiveModel: string | undefined = (body as Record<string, unknown>).chatModel as
    | string
    | undefined;
  let anonymizeMapping: Mapping = {};
  let anonymizationActive = false;
  let anonymizationNotice = '';
  let anonymizedDocsContext = hiddenDocsContext;

  if (anonymizeMode) {
    try {
      let mapping = await loadConversationMapping(conversationId);

      // Документ: серверная анонимизация только если mapping пуст (preview не было).
      // Сохраняем полный серверный anonymized_text — в нём NER уже заменил и
      // одиночные имена («Никита»), которые локальная forward-подстановка по
      // полному ФИО могла бы пропустить (утечка ПДн в облако).
      let serverAnonymizedDoc: string | null = null;
      if (hiddenDocsContext.trim() && Object.keys(mapping).length === 0) {
        const r = await anonymizeNewText(hiddenDocsContext, conversationId);
        mapping = r.mapping;
        serverAnonymizedDoc = r.anonymizedText;
      }

      // Последнее сообщение пользователя — короткое, серверная анонимизация быстра.
      const lastUserMsg = [...finalMessages].reverse().find((m) => m?.role === 'user');
      const lastUserText =
        typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';
      if (lastUserText.trim()) {
        const r2 = await anonymizeNewText(lastUserText, conversationId);
        mapping = r2.mapping;
      }

      // Финальная зачистка всего, что уходит в облако:
      //   applyMappingForward (подстановка известных значений) → scrubStructured
      //   (защитный фильтр email/телефонов/длинных ID, что мог пропустить NER).
      let conv: ConversationMapping = { mapping, counters: countersFromMapping(mapping) };
      {
        // Предпочитаем полный серверный результат (в нём одиночные имена уже
        // заменены); при его отсутствии — детерминированная локальная
        // «глубокая» подстановка (включая компоненты ФИО).
        const docLocal = serverAnonymizedDoc ?? anonymizeWithMapping(hiddenDocsContext, conv.mapping);
        const sc = scrubStructured(docLocal, conv);
        conv = sc.conversation;
        // Словарный фильтр гос/орг-наименований, что пропустил NER (Минфин и т.п.).
        const so = scrubSensitiveOrgs(sc.text, conv);
        conv = so.conversation;
        // Даты и вежливые фразы — не ПДн: возвращаем оригиналы, чтобы облачная
        // модель видела реальные даты (сроки!) и нормальный текст.
        anonymizedDocsContext = restoreNonSensitivePlaceholders(so.text, conv.mapping).text;
      }
      finalMessages = finalMessages.map((m) => {
        if (typeof m?.content !== 'string') return m;
        const local = anonymizeWithMapping(m.content, conv.mapping);
        const sc = scrubStructured(local, conv);
        conv = sc.conversation;
        const so = scrubSensitiveOrgs(sc.text, conv);
        conv = so.conversation;
        const restoredText = restoreNonSensitivePlaceholders(so.text, conv.mapping).text;
        return { ...m, content: restoredText, parts: [{ type: 'text' as const, text: restoredText }] };
      });
      // Если защитный фильтр добавил новые сущности — сохраняем mapping.
      if (Object.keys(conv.mapping).length !== Object.keys(mapping).length) {
        await persistConversationMapping(conversationId, conv);
      }
      mapping = conv.mapping;
      anonymizeMapping = mapping;
      anonymizationActive = true;

      // Принудительно облачная модель.
      effectiveProvider = 'openrouter';
      // normalizeCloudModel: пустой или мёртвый слаг (owl-alpha из старого env) → дефолт.
      effectiveModel = normalizeCloudModel(process.env.ANONYMIZER_CLOUD_MODEL);
      console.log(
        `🔒 anonymize active: mapping=${Object.keys(mapping).length} entries → ${effectiveModel}`,
      );
    } catch (e) {
      if (e instanceof AnonymizerUnavailableError) {
        // Fallback на локальную LLM (там ПДн допустимы) + уведомление пользователю.
        anonymizationActive = false;
        anonymizeMapping = {};
        anonymizedDocsContext = hiddenDocsContext;
        effectiveProvider = 'ollama';
        effectiveModel = undefined;
        anonymizationNotice =
          '⚠️ Анонимизатор недоступен — отвечаю через локальную модель (данные не уходят в облако).';
        console.warn('🔒 anonymize unavailable → local fallback:', e.message);
      } else {
        throw e;
      }
    }
  }

  // Есть ли существенный документ в системном блоке (> 8 кБ)?
  const hasInlineTranscript =
    !ragOmitsAttachmentBodies &&
    hasSubstantialInlineTranscript(hiddenDocsFull, hiddenDocsContext);

  let ragRetrievalEnabled =
    Boolean(useRagContext) && Boolean(process.env.RAG_API_URL?.trim());
  if (ragRetrievalEnabled && hasInlineTranscript) {
    console.log(
      '📎 RAG tool off: full transcript already in system block (inline attachment)',
    );
    ragRetrievalEnabled = false;
  }
  const ragModeStr =
    typeof ragMode === 'string' && ['hybrid', 'local', 'global'].includes(ragMode)
      ? ragMode
      : 'hybrid';

  let languageModel;
  try {
    languageModel = resolveChatLanguageModel({
      chatProvider: effectiveProvider,
      chatModel: effectiveModel,
      useThinking: Boolean((body as Record<string, unknown>).useThinking),
    });
  } catch (err) {
    console.error('Failed to resolve language model:', err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Language model configuration error',
      }),
      { status: 500 }
    );
  }

  const ragTranscript = hydratedChatTranscriptForRag(finalMessages, 12000);
  /** Fallback: один вопрос по следующему разделу, не «суп» из всех реплик user. */
  const ragAutoQueryFallback = fallbackRagQuestion();

  /** Не подставлять в системный промпт «пустой» RAG — модель начинает вести себя как без фактов из индекса. */
  const minRagContextChars = 80;

  let ragAutoContext: string | undefined;
  if (ragRetrievalEnabled && ragTranscript.trim().length > 0) {
    try {
      let queryLine = '';
      try {
        queryLine = await generateRagSearchQueryLine({
          model: languageModel,
          transcript: ragTranscript,
          purposeFocus: RAG_AUTO_PURPOSE_FOCUS,
          abortSignal: req.signal,
        });
      } catch (genErr) {
        console.warn('📚 RAG query-line generation failed, using fallback text:', genErr);
      }
      const snippetQuery = stripTextForRagQuery(
        queryLine.trim() || ragAutoQueryFallback,
      );
      if (snippetQuery) {
        if (!conversationId) {
          console.warn(
            '📚 RAG auto: conversationId missing — запрос уйдёт в глобальный индекс (conv=default), не в индекс диалога',
          );
        }
        const rawSnippet = await fetchRagSnippet(snippetQuery, ragModeStr, conversationId);
        const trimmedSnippet = rawSnippet?.trim() ?? '';
        if (trimmedSnippet.length >= minRagContextChars) {
          ragAutoContext = trimmedSnippet;
        }
    console.log(`📚 RAG auto: q=${snippetQuery.slice(0, 80)} excerpt=${trimmedSnippet.length}c injected=${Boolean(ragAutoContext)}`);
      }
    } catch (e) {
      console.warn('📚 RAG auto-retrieval failed:', e);
    }
  }

  let systemPrompt = buildSystemPrompt(
    userPrompt,
    anonymizedDocsContext,
    ragAutoContext?.trim() ? ragAutoContext : undefined,
    ragOmitsAttachmentBodies,
  );

  const lastTurn =
    finalMessages.length > 0 ? finalMessages[finalMessages.length - 1] : null;
  systemPrompt += buildFileOnlyTurnAppendix(lastTurn, {
    protocolTranscriptReady: hasInlineTranscript,
  });

  const userSection1 = userProvidedSection1InTranscript(ragTranscript);
  if (userSection1) {
    systemPrompt += buildUserProvidedSection1Appendix(userSection1, {
      ragToolEnabled: ragRetrievalEnabled,
    });
  }

  if (ragRetrievalEnabled) {
    systemPrompt += RAG_TOOL_MODE_SYSTEM_APPENDIX;
  }

  if (hasInlineTranscript) {
    systemPrompt += PROTOCOL_CHAT_TIMECODE_APPENDIX;
    // Детерминированный слот-скан расшифровки → якорь для блока «Не хватает».
    if (anonymizedDocsContext.trim()) {
      systemPrompt +=
        '\n' + formatSlotScanForPrompt(analyzeTranscriptSlots(anonymizedDocsContext));
    }
  }

  // Inject current date + day-of-week so the LLM can resolve relative dates ("до конца недели" etc.)
  {
    const DAY_NAMES_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const dayName = DAY_NAMES_RU[now.getDay()];
    systemPrompt += `\n\n[КОНТЕКСТ ДАТЫ: Текущая дата — ${dd}.${mm}.${yyyy} (${dayName}). Используй для вычисления абсолютных дат из относительных выражений. Если выражение требует знания дня недели даты встречи и ты не можешь вычислить точную дату — задай уточняющий вопрос пользователю.]`;
  }

  // Режим анонимизации: жёстко запрещаем модели выдумывать имена и подставлять
  // примеры из системного промпта вместо плейсхолдеров.
  if (anonymizationActive) {
    systemPrompt += ANONYMIZE_MODE_SYSTEM_APPENDIX;
  }

  // messages-prepared verbose log removed

  // 5. Create Agent Context - with safety checks
  let coreMessages;
  try {
    const messagesToConvert = finalMessages.length > 0 ? finalMessages : normalizedMessagesNonEmpty;
    if (!Array.isArray(messagesToConvert) || messagesToConvert.length === 0) {
      throw new Error('No valid messages to convert');
    }
    coreMessages = convertToModelMessages(messagesToConvert);
  } catch (error) {
    console.error('❌ Failed to convert messages:', error);
    // Fallback: try to preserve at least the last user message
    const lastMessage = normalizedMessagesNonEmpty[normalizedMessagesNonEmpty.length - 1];
    coreMessages = lastMessage ? [{
      role: lastMessage.role as 'user' | 'assistant',
      content: typeof lastMessage.content === 'string' ? lastMessage.content : 'Hello',
    }] : [{
      role: 'user' as const,
      content: 'Hello',
    }];
  }

  // Режим анонимизации: документ правой панели содержит РЕАЛЬНЫЕ данные (после
  // обратной подстановки) — перед отправкой в облако зачищаем его по mapping,
  // иначе chat-agent вставит его в системный промпт сырым (утечка ПДн).
  const safeDocumentContent =
    anonymizationActive && typeof documentContent === 'string' && documentContent.trim()
      ? anonymizeWithMapping(documentContent, anonymizeMapping)
      : documentContent;

  const agentContext: AgentContext = {
    messages: coreMessages,
    uiMessages: normalizedMessagesNonEmpty,
    userPrompt: userPrompt,
    userId,
    conversationId,
    documentContent: safeDocumentContent,
    model: languageModel,
    abortSignal: req.signal,
    ragRetrievalEnabled,
    hasInlineTranscript,
    useThinking: Boolean(body.useThinking),
    ragMode: ragModeStr,
    anonymize: anonymizationActive,
    anonymizeMapping,
  };

  const systemPromptTokensEst = Math.ceil(systemPrompt.length / 2.34);
  console.log(
    `📐 context: system≈${systemPromptTokensEst}tok doc≈${docTokensEstimate}tok inline=${hasInlineTranscript} msgs=${finalMessages.length} anon=${anonymizationActive}`,
  );

  // 6. Run Main Agent
  let agentResponse = await runMainAgent(agentContext, systemPrompt, userPrompt);

  // Деанонимизация ответа «на лету» — клиент видит реальные данные.
  if (anonymizationActive && Object.keys(anonymizeMapping).length > 0) {
    agentResponse = wrapResponseWithDeanonymization(agentResponse, anonymizeMapping);
  }

  // Fallback-уведомление пользователю (анонимизатор недоступен → локальная модель).
  if (anonymizationNotice) {
    agentResponse = prependNoticeToResponse(agentResponse, anonymizationNotice);
  }

  return agentResponse;
}
