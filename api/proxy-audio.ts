// Vercel Edge Function: server-side audio proxy.
//
// Ports the logic from the former Netlify Function (netlify/functions/proxy-audio.ts)
// and server.ts (/api/proxy-audio) so that static-only Vercel deployments can fetch
// Cleanvoice's cleaned-audio URLs (hosted on Cloudflare R2 / S3-compatible storage)
// without hitting the browser's CORS restrictions.
//
// The browser calls GET /api/proxy-audio?url=<remote audio URL>; this function
// fetches the remote asset server-side and streams the bytes back with CORS
// headers attached. Vercel auto-routes /api/proxy-audio (and any sub-path) to
// this file.
//
// Implemented as an Edge Function (Web standard Request/Response) so it needs no
// @vercel/node dependency and type-checks under the project's existing tsconfig
// (DOM lib provides Request/Response/fetch/URL/Headers/TextDecoder/ReadableStream).
// Bytes are STREAMED back rather than base64-buffered, which avoids the Edge
// non-streaming response size cap and keeps memory flat for large exports.

export const config = { runtime: 'edge' };

// SSRF guard — ported verbatim from server.ts (isAllowedProxyTarget).
// Blocks loopback, link-local, private, and other non-routable IP ranges.
function isAllowedProxyTarget(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    // Only permit http(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    // Reject obvious local hostnames
    if (host === 'localhost' || host === '') return false;
    // Reject IPv4 in private/loopback/link-local/reserved ranges
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a] = ipv4.slice(1).map(Number);
      if (a === 10) return false;            // 10.0.0.0/8
      if (a === 127) return false;           // loopback
      if (a === 0) return false;             // 0.0.0.0/8
      if (a === 169) return false;           // 169.254.0.0/16 link-local (incl. cloud metadata)
      if (a === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31) return false; // 172.16/12
      if (a === 192 && Number(ipv4[2]) === 168) return false; // 192.168/16
      if (a >= 224) return false;            // multicast / reserved
    }
    // Reject IPv6 loopback / link-local / unique-local
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
    if (host === '::ffff:127.0.0.1') return false;
    return true;
  } catch {
    return false;
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Derive a file extension from the remote URL pathname (matches server.ts logic).
const ALLOWED_EXTS = ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'];
function deriveExt(targetUrl: string): string {
  let ext = 'mp3';
  try {
    const pathname = new URL(targetUrl).pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot !== -1) {
      const possibleExt = pathname.substring(lastDot + 1).toLowerCase();
      if (ALLOWED_EXTS.includes(possibleExt)) ext = possibleExt;
    }
  } catch {
    // keep default
  }
  return ext;
}

// Some S3/R2 signed URLs reject requests that omit a User-Agent; the Edge fetch
// may also forbid overriding User-Agent, so this is best-effort and any throw is
// swallowed by the retry loop.
const UA_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

async function fetchUpstream(url: string): Promise<Response | undefined> {
  // 1. Try with NO custom headers first (most reliable for S3/GCS signed URLs).
  let response: Response | undefined;
  try {
    response = await fetch(url);
  } catch {
    // fall through to retry loop
  }

  // 2. Retry loop with a User-Agent header if the first fetch failed / non-OK.
  if (!response || !response.ok) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetch(url, { headers: UA_HEADERS });
        if (response.ok) break;
      } catch {
        // try again
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  return response;
}

export default async function handler(request: Request): Promise<Response> {
  const method = (request.method || 'GET').toUpperCase();

  // Respond to CORS preflight so the browser allows the proxied request.
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url).searchParams.get('url');
  if (!url || typeof url !== 'string') {
    return json(400, { error: 'Missing url parameter' });
  }

  // This function only exists to proxy absolute remote URLs; relative paths
  // aren't meaningful on static hosting.
  if (url.startsWith('/')) {
    return json(400, { error: 'Relative URLs are not supported by this proxy' });
  }

  if (!isAllowedProxyTarget(url)) {
    return json(403, { error: 'Requested URL is not permitted' });
  }

  const ext = deriveExt(url);

  // --- HEAD: forward a HEAD request and echo content-length/type/status ---
  if (method === 'HEAD') {
    try {
      const headRes = await fetch(url, { method: 'HEAD' });
      const headers: Record<string, string> = { ...CORS_HEADERS };
      const len = headRes.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      headers['Content-Type'] = headRes.headers.get('content-type') || 'audio/mpeg';
      return new Response(null, { status: headRes.status, headers });
    } catch {
      return new Response(null, { status: 500, headers: CORS_HEADERS });
    }
  }

  // --- GET: fetch the bytes and stream them back ---
  try {
    const response = await fetchUpstream(url);

    if (!response || !response.ok) {
      const status = response ? response.status : 502;
      return json(status, { error: `Upstream returned status ${status}` });
    }

    const contentType = response.headers.get('content-type') || `audio/${ext}`;
    const reader = response.body?.getReader();

    if (!reader) {
      // No streaming body available — materialize once and inspect/return.
      const buf = await response.arrayBuffer();
      const startBytes = new TextDecoder().decode(new Uint8Array(buf).subarray(0, 120)).trim();
      if (
        startBytes.startsWith('<') ||
        startBytes.includes('AccessDenied') ||
        startBytes.includes('NoSuchKey') ||
        startBytes.includes('Error')
      ) {
        return json(502, { error: 'Upstream returned an error document (AccessDenied/NoSuchKey)' });
      }
      return new Response(buf, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="audio.${ext}"`,
        },
      });
    }

    // S3 error-document detection: inspect the FIRST chunk before committing to
    // streaming. If it looks like an XML error (AccessDenied/NoSuchKey), refuse
    // to return it as "audio" — this is the exact cause of the decoder crash in
    // the original bug report (a 127-byte R2 error XML fed to decodeAudioData).
    const { value: firstChunk, done } = await reader.read();
    if (done) {
      return new Response(null, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="audio.${ext}"`,
        },
      });
    }

    const startBytes = new TextDecoder()
      .decode((firstChunk || new Uint8Array()).subarray(0, 120))
      .trim();
    if (
      startBytes.startsWith('<') ||
      startBytes.includes('AccessDenied') ||
      startBytes.includes('NoSuchKey') ||
      startBytes.includes('Error')
    ) {
      try { reader.cancel(); } catch {}
      return json(502, { error: 'Upstream returned an error document (AccessDenied/NoSuchKey)' });
    }

    // Replay the first chunk, then pump the remainder of the upstream stream
    // straight into the response. This keeps memory flat for large exports
    // (no full-buffer/base64 round-trip) and avoids the Edge response size cap.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstChunk && firstChunk.byteLength > 0) controller.enqueue(firstChunk);
        const pump = () => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                controller.close();
                return;
              }
              controller.enqueue(value as Uint8Array);
              pump();
            })
            .catch(() => {
              // Mid-stream network blip: end gracefully so the client can retry
              // rather than surfacing a hard error.
              controller.close();
            });
        };
        pump();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="audio.${ext}"`,
      },
    });
  } catch {
    return json(500, { error: 'Failed to load audio asset' });
  }
}
