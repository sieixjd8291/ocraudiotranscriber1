// Vercel Edge Function: server-side proxy for the Cleanvoice v2 API.
//
// The browser calls same-origin /api/cleanvoice/* routes. A vercel.json rewrite
// maps /api/cleanvoice/:path* onto this single file, passing the Cleanvoice
// path via the `_cv` query param (e.g. /api/cleanvoice/v2/edits/{id}  ->
// /api/cleanvoice?_cv=v2/edits/{id}). This flat-file form is reliably detected
// by Vercel's build (matching api/proxy-audio.ts), unlike a bracketed
// catch-all which 404'd in production.
//
// Why this exists:
//  - Eliminates client-side CORS preflights (requests are same-origin).
//  - Avoids the per-IP rate-limit/block that direct browser→api.cleanvoice.ai
//    status polling hit, which permanently stalled job progress updates.
//  - Returns immediately for POST /v2/edits (editId is created synchronously);
//    processing is polled client-side, so no Vercel 504 can occur.
//
// All client headers (incl. X-API-Key) are forwarded; audio binary upload's
// PUT to GCS stays direct and never touches this function.

export const config = { runtime: 'edge' };

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const UPSTREAM = 'https://api.cleanvoice.ai';
const DROP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer',
]);

export default async function handler(request: Request): Promise<Response> {
  const method = (request.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  // The Cleanvoice API path arrives via `_cv` (set by the vercel.json rewrite).
  // Fall back to reading the trailing pathname so the function also works if a
  // future rewrite passes the path differently.
  let cvPath = url.searchParams.get('_cv') || '';
  if (!cvPath) {
    cvPath = url.pathname.replace(/^\/api\/cleanvoice/, '');
  }
  cvPath = '/' + cvPath.replace(/^\//, '');

  // Forward every query param upstream (including _t to break Vercel caches)
  const upParams = new URLSearchParams(url.search);
  upParams.delete('_cv');
  const qs = upParams.toString();
  const target = `${UPSTREAM}${cvPath}${qs ? `?${qs}` : ''}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (DROP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });

  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await request.text();
  }

  try {
    const upstream = await fetch(target, init);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    // TIER 1 — stream the upstream body straight through instead of buffering it
    // with `await upstream.text()`. Buffering forced this Edge function to wait
    // for the LAST upstream byte before sending its FIRST byte to the browser,
    // adding the full upstream download time to time-to-first-byte on every
    // status poll. Passing `upstream.body` through also keeps memory flat.
    //
    // Caveat: an upstream failure that occurs mid-stream can no longer be
    // converted into the 502 JSON below, because headers are already sent by
    // then. That is the correct trade here — these are small JSON status
    // payloads, and the client already treats a truncated/unparseable response
    // as a transient error and retries.
    
    // Ensure Vercel Edge network or browser CDN doesn't cache the API response.
    // By setting these headers, we override the default 's-maxage' from vercel.json.
    const responseHeaders = {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'CDN-Cache-Control': 'no-store',
    };

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    return new Response(
      JSON.stringify({ error: 'Upstream Cleanvoice request failed' }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  }
}
