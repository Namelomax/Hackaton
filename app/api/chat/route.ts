import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { 
  convertToModelMessages, 
} from 'ai';
import crypto from 'crypto';
import { getPrompt, updatePrompt, createPromptForUser, getUserSelectedPrompt, getPromptById, saveConversation, updateConversation } from '@/lib/getPromt';
import { runMainAgent } from './agents/main-agent';
import { AgentContext } from './agents/types';

export const maxDuration = 300;
export const runtime = 'nodejs';

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
  baseURL: 'https://openrouter.ai/api/v1',
  compatibility: 'strict',
  headers: {
    ...(process.env.OPENROUTER_REFERER ? { 'HTTP-Referer': process.env.OPENROUTER_REFERER } : {}),
    'X-Title': 'AISDK',
  },
});

// Включаем reasoning у модели по умолчанию: OpenRouter прокидывает этот флаг дальше в модель
// (для mimo-v2-flash reasoning заявлен в capabilities). budget_tokens можно отрегулировать при необходимости.
const model = openrouter.chat('tngtech/deepseek-r1t2-chimera:free');

let cachedPrompt: string | null = null;

function buildSystemPrompt(userPrompt: string, hiddenDocsContext?: string): string {
  return `
===== ВЛОЖЕНИЯ ПОЛЬЗОВАТЕЛЯ (КОНТЕКСТ) =====
${hiddenDocsContext}

ИНСТРУКЦИЯ ПО РАБОТЕ С ВЛОЖЕНИЯМИ:
1. Это справочные материалы. НЕ делай их краткий пересказ (summary), если пользователь об этом явно не попросил.
2. Используй информацию из них только для ответов на конкретные вопросы или выполнения задач пользователя.
3. Если пользователь не задал вопрос, просто подтверди получение файлов и скажи, что готов работать с ними согласно твоей основной инструкции.
===== КОНЕЦ ВЛОЖЕНИЙ =====`;
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

function dataUrlToBuffer(dataUrl?: string | null): Buffer | null {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:[^;]+;base64,(.+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
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
  const buf = dataUrlToBuffer(att.url || att.data);
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
  const buf = dataUrlToBuffer(att?.url || att?.data);
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
  const buf = dataUrlToBuffer(att.url || att.data);
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
  const buf = dataUrlToBuffer(att.url || att.data);
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

// === MAIN HANDLER ===

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  let { messages, newSystemPrompt, userId, selectedPromptId, documentContent } = body as any;
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

  console.log('📨 Request info:', {
    messagesCount: messages.length,
    userId: userId || 'anon',
    conversationId: conversationId || 'none',
    hasDocumentContent: !!documentContent,
  });

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

  console.log('📝 Base messages prepared:', baseMessages.length);

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

  console.log('✅ Normalized messages:', normalizedMessagesNonEmpty.length);

  // 3. Process Attachments
  for (const msg of normalizedMessagesNonEmpty) {
    const atts: any[] = Array.isArray(msg?.metadata?.attachments) ? msg.metadata.attachments : [];
    if (!atts.length) continue;

    const collected: string[] = [];

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
  
  // Prepare hidden docs context and enrich messages with file content
  const hiddenDocEntries: string[] = [];
  const messagesWithHidden: any[] = [];
  
  normalizedMessagesNonEmpty.forEach((msg) => {
    const hiddenTexts: string[] = Array.isArray((msg as any)?.metadata?.hiddenTexts)
      ? (msg as any).metadata.hiddenTexts
      : [];
    const attachmentsMeta: any[] = Array.isArray((msg as any)?.metadata?.attachments)
      ? (msg as any).metadata.attachments
      : [];

    // Build file content summary for context
    const fileContents: string[] = [];
    hiddenTexts.forEach((hidden, idx) => {
      const cleaned = String(hidden ?? '').trim();
      if (!cleaned) return;
      const attName = attachmentsMeta[idx]?.name || attachmentsMeta[idx]?.filename;
      const label = attName ? `Документ "${attName}"` : `Документ ${hiddenDocEntries.length + 1}`;
      const snippet = cleaned.length > 1200 ? `${cleaned.slice(0, 1200)} …` : cleaned;
      hiddenDocEntries.push(`${label}:\n${snippet}`);
      
      // Add full content to this message
      fileContents.push(`\n\n---\nВложенный файл: ${attName || 'документ'}\n${cleaned}\n---`);
    });
    
    // If message has file attachments, append their content to the message
    if (fileContents.length > 0) {
      const enrichedContent = `${msg.content}${fileContents.join('')}`;
      messagesWithHidden.push({
        ...msg,
        content: enrichedContent,
        parts: [{ type: 'text' as const, text: enrichedContent }],
      });
    } else {
      messagesWithHidden.push(msg);
    }
  });

  const hiddenDocsContext = hiddenDocEntries.length
    ? hiddenDocEntries.join('\n\n').slice(0, 4000)
    : '';

  const systemPrompt = buildSystemPrompt(userPrompt, hiddenDocsContext);

  console.log('📦 Messages prepared:', {
    messagesWithHidden: messagesWithHidden.length,
    normalizedMessages: normalizedMessagesNonEmpty.length,
    hiddenDocEntries: hiddenDocEntries.length,
  });

  // 5. Create Agent Context - with safety checks
  let coreMessages;
  try {
    const messagesToConvert = messagesWithHidden.length > 0 ? messagesWithHidden : normalizedMessagesNonEmpty;
    console.log('🔄 Converting messages:', messagesToConvert.length);
    
    if (!Array.isArray(messagesToConvert) || messagesToConvert.length === 0) {
      throw new Error('No valid messages to convert');
    }
    
    coreMessages = convertToModelMessages(messagesToConvert);
    console.log('✅ Messages converted successfully');
  } catch (error) {
    console.error('❌ Failed to convert messages:', error);
    console.error('Messages data:', JSON.stringify({ messagesWithHidden, normalizedMessages: normalizedMessagesNonEmpty }, null, 2));
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

  const agentContext: AgentContext = {
    messages: coreMessages,
    uiMessages: normalizedMessagesNonEmpty,
    userPrompt: userPrompt,
    userId,
    conversationId,
    documentContent,
    model,
  };

  // 6. Run Main Agent
  return runMainAgent(agentContext, systemPrompt, userPrompt);
}
