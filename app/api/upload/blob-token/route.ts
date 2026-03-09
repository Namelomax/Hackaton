import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

export const runtime = 'nodejs';

/**
 * Token endpoint for Vercel Blob client-side uploads.
 * The browser calls this automatically when using `upload()` from @vercel/blob/client.
 * It never receives the file itself — it only issues a short-lived upload token.
 * The file is then streamed directly from the browser to Vercel Blob storage,
 * bypassing the 4.5 MB serverless function payload limit entirely.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname: string) => {
        // Allow any file type; add a random suffix to avoid collisions.
        return {
          allowedContentTypes: ['*/*'],
          addRandomSuffix: true,
          // Tokens expire after 30 seconds — just long enough for the upload.
          maximumSizeInBytes: 50 * 1024 * 1024, // 50 MB per file
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Nothing to do after upload; the client gets the URL directly.
        console.log('[blob-token] Upload completed:', blob.pathname);
      },
    });

    return Response.json(jsonResponse);
  } catch (err: any) {
    const errorMessage = String(err?.message || err);
    
    // Vercel Blob not configured — expected in local development
    if (errorMessage.includes('No token found')) {
      console.warn('[blob-token] Vercel Blob not configured (missing BLOB_READ_WRITE_TOKEN)');
      return Response.json(
        { 
          error: 'BLOB_NOT_CONFIGURED',
          message: 'Vercel Blob not configured. Using local data URL fallback for small files (<3MB).'
        }, 
        { status: 503 } // Service Unavailable — clients can retry with fallback
      );
    }
    
    console.error('[blob-token] handleUpload error:', err);
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
