import { bestEffortBinaryText, extractLegacyDoc } from '@/lib/attachment-extract';

const GEMINI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY!;
const GEMINI_UPLOAD_URL = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`;

export const runtime = "nodejs";

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File;

  if (!file) {
    return new Response(JSON.stringify({ error: "Файл не найден" }), { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Пытаемся извлечь текст локально: поддержка txt/md/json и docx через mammoth
  const contentType = (file.type || '').toLowerCase();
  let extractedText: string | null = null;

  try {
    if (contentType.includes('text/') || file.name.endsWith('.md') || file.name.endsWith('.txt')) {
      extractedText = buffer.toString('utf8');
    } else if (file.name.endsWith('.json')) {
      extractedText = buffer.toString('utf8');
    } else if (file.name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (file.name.endsWith('.xls') || file.name.endsWith('.xlsx') || contentType === 'application/vnd.ms-excel' || contentType.includes('spreadsheetml')) {
      try {
        const XLSX = await import('xlsx');
        // xlsx library supports both .xlsx and legacy .xls formats
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        let text = '';
        workbook.SheetNames.forEach((sheetName: string) => {
          const sheet = (workbook as any).Sheets[sheetName];
          text += `Sheet: ${sheetName}\n`;
          text += (XLSX as any).utils.sheet_to_txt(sheet);
          text += '\n\n';
        });
        extractedText = text.trim() || null;
      } catch (err) {
        console.error('Failed to parse Excel file:', err);
        extractedText = bestEffortBinaryText(buffer);
      }
    } else if (file.name.endsWith('.doc') || contentType === 'application/msword') {
      extractedText = await extractLegacyDoc(buffer);
      if (!extractedText) extractedText = bestEffortBinaryText(buffer);
    } else if (file.name.endsWith('.ppt') || file.name.endsWith('.pptx') || contentType === 'application/vnd.ms-powerpoint' || contentType.includes('presentationml')) {
      // For PPTX we could use JSZip similar to chat/route.ts, for now fallback to binary
      extractedText = bestEffortBinaryText(buffer);
    }
  } catch (err) {
    console.error('Local text extraction failed:', err);
  }

  // Фолбек: загружаем в Gemini и отдаем fileId, если текст извлечь не удалось
  if (!extractedText) {
    const res = await fetch(GEMINI_UPLOAD_URL, {
      method: "POST",
      headers: {
        "Content-Type": file.type,
        "x-goog-upload-file-name": encodeURIComponent(file.name),
        "x-goog-upload-content-type": file.type,
      },
      body: buffer,
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Ошибка загрузки в Gemini:", data);
      return new Response(JSON.stringify(data), { status: res.status });
    }

    return new Response(
      JSON.stringify({
        fileId: data.name,
        fileName: file.name,
        content: null,
      }),
      { status: 200 }
    );
  }

  return new Response(
    JSON.stringify({
      fileId: null,
      fileName: file.name,
      content: extractedText,
    }),
    { status: 200 }
  );
}
