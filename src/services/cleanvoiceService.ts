export function preloadCleanvoiceConnection(): void {
  if (typeof window === "undefined" || !document) return;

  if (!document.getElementById("cv-preconnect")) {
    const link = document.createElement("link");
    link.id = "cv-preconnect";
    link.rel = "preconnect";
    link.href = "https://api.cleanvoice.ai";
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  if (!document.getElementById("gcs-preconnect")) {
    const link = document.createElement("link");
    link.id = "gcs-preconnect";
    link.rel = "preconnect";
    link.href = "https://storage.googleapis.com";
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  // NOTE: a previous version fired a HEAD /v2/configurations probe here on every
  // drag-enter / mouse-enter to "warm" an HTTP/2 connection. The browser already
  // pools connections via the preconnect hint, and the probe just added a wasted
  // authenticated round-trip (and a dead AbortController map) on every interaction.
}

export function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    // Static-only hosts (GitHub Pages, Netlify) have no /api serverless route,
    // so they must fetch from the official Cleanvoice API directly.
    if (
      hostname.includes("github.io") ||
      hostname.includes("netlify")
    ) {
      return "https://api.cleanvoice.ai";
    }
    // All other hosts (Vercel, Vercel custom domains, localhost, Cloud Run, and AI Studio
    // development containers) support routing through the local same-origin /api/cleanvoice
    // proxy, which eliminates browser CORS preflights and bypasses per-IP limits.
    return "/api/cleanvoice";
  }
  return "https://api.cleanvoice.ai";
}

/**
 * Returns true only when the full Express backend (server.ts) is serving the
 * app — i.e. localhost or the AI Studio / Cloud Run dev hosts. On these hosts
 * the same-origin `/api/proxy-audio` endpoint exists, so the browser can fetch
 * Cleanvoice's R2 result audio through it. On static-only hosts (Vercel
 * serverless, Netlify, GitHub Pages, direct-API mode) that endpoint does not
 * exist and R2 returns no CORS headers, so any browser-side pre-fetch of the
 * result audio is guaranteed to fail (CORS / 404) and only spams the console.
 * Used to gate optimistic audio pre-warming; playback still works via a direct
 * <audio src> element, which does not enforce CORS.
 */
export function hasServerBackend(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".run.app") ||
    hostname.endsWith(".asia-east1.run.app") ||
    hostname.endsWith(".aistudio-build.com")
  );
}

/**
 * Service to interface with the Cleanvoice API (v2)
 */

export interface CleanvoiceConfig {
  fillers: boolean;
  stutters: boolean;
  silences: boolean;
  hesitations: boolean;
  mouth_sounds: boolean;
  mute: boolean;
  // Noise removal model: "v2" (newest, strongest — silences background between
  // speech), "legacy" (previous model), true (API default, same as v2), false (off).
  noise?: boolean | "v2" | "legacy";
  reverb?: boolean;
  normalize?: boolean | string;
  eq?: boolean;
  format?: "mp3" | "wav" | "m4a";
  transcribe?: boolean;
  summarize?: boolean;
  social_content?: boolean;
  keep_music?: boolean;
  remove_breath?: boolean | "natural" | "mute" | "legacy" | "disabled";
  studio_sound?:
    | boolean
    | "nightly"
    | "standard"
    | "repair"
    | "studio_repair"
    | "javelin"
    | "disabled";
  start_time?: number;
  end_time?: number;
  targetBitrate?: string | null;
}

export interface CleanvoiceJobStatus {
  id: string;
  status: "processing" | "success" | "error";
  rawStatus?: string;
  progressPercentage?: number;
  download_url?: string;
  error?: string;
  isRateLimited?: boolean;
  edits?: Array<{ start: number; end: number; type: string }>;
  duration?: number;
  createdAt?: string;
  transcription?: string;
  summary?: string;
  social_content?: string;
  serverElapsedSeconds?: number;
  remainingCredits?: number;
  isQueued?: boolean;
}

/**
 * Get Cleanvoice API Headers
 */
function getHeaders(apiKey: string) {
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };
}

let lastRedirectTime = 0;

// Tracks which edit IDs have already had their export POST triggered this
// session, so we don't re-fire the export render request on every poll tick
// while the server hasn't yet returned an `export` object (the v2 API can
// respond with no `export` field for several ticks after the POST is acked).
const exportTriggeredEdits = new Set<string>();

// Counts consecutive "success without download_url" polls per edit so the
// fallback /export POST waits one grace tick before firing — the initial
// POST /v2/edits payload already requests an export, so the render is usually
// already in flight and the `export` object simply hasn't appeared in the
// status response yet.
const exportGraceTicks = new Map<string, number>();

export function triggerCleanvoiceAuthOrCreditError() {
  if (typeof window !== "undefined" && (window as any).activeAppTool !== "cleanvoice") {
    return;
  }
  const now = Date.now();
  if (now - lastRedirectTime > 5000) {
    lastRedirectTime = now;
    if (typeof window !== "undefined") {
      // 1. Immediately disconnect the key from localStorage
      localStorage.removeItem("cleanvoice_api_key");
      localStorage.setItem("cleanvoice_api_key_disconnected", "true");
      window.dispatchEvent(new CustomEvent("cleanvoice-key-disconnected"));

      // 2. Open up Cleanvoice settings connection pop-up menu
      window.dispatchEvent(new Event("open-cleanvoice-settings"));

      // 3. Open up the delete account page (fallback to redirection if popup blocker is active)
      try {
        const popup = window.open("https://app.cleanvoice.ai/settings", "_blank");
        if (!popup || popup.closed || typeof popup.closed === "undefined") {
          window.location.href = "https://app.cleanvoice.ai/settings";
        }
      } catch (err) {
        window.location.href = "https://app.cleanvoice.ai/settings";
      }
    }
  }
}

// NOTE: A global console.warn/console.error monkey-patch previously lived here
// to detect "out of credits" / "invalid api key" messages. It JSON.stringify'd
// every console call app-wide (high overhead during verbose FFmpeg/Gemini logging).
// Auth/credit errors are now handled explicitly via checkCreditExhaustion() at
// each API response site, so the patch was redundant and has been removed.

/**
 * Handle API credit exhaustion or invalid API key gracefully.
 * NOTE: only match specific, well-formed Cleanvoice API messages here. Earlier
 * versions matched bare words like "balance" / "insufficient" / "unauthorized",
 * which caused unrelated errors containing those words to wipe the user's API
 * key and force-redirect them to settings. Status codes 401/402 remain the
 * authoritative signal; substrings are only a secondary catch for known strings.
 */
function checkCreditExhaustion(status: number, responseText: string): void {
  const textLow = responseText.toLowerCase();
  if (
    status === 402 ||
    status === 401 ||
    textLow.includes("out of credits") ||
    textLow.includes("no credits remaining") ||
    textLow.includes("insufficient credits") ||
    textLow.includes("credits_remaining: 0") ||
    textLow.includes("invalid api key") ||
    textLow.includes("invalid_api_key") ||
    textLow.includes("api key is invalid") ||
    textLow.includes("unauthorized access") ||
    textLow.includes("account balance is too low") ||
    textLow.includes("insufficient balance")
  ) {
    console.warn("[Cleanvoice API] API Key Error or Credit exhaustion detected. Redirecting user to settings.");
    triggerCleanvoiceAuthOrCreditError();
  }
}

/**
 * Parse HTML or JSON error pages (like Cloudflare, service timeouts, or credit exhaustion) and extract meaningful summaries
 */
function parseHtmlError(html: string, status: number): string {
  // First attempt to parse as clean JSON to retrieve explicit Cleanvoice messages
  try {
    const trimmed = html.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const parsedJSON = JSON.parse(trimmed);
      const errorObj =
        parsedJSON.error ||
        parsedJSON.detail?.error ||
        parsedJSON.detail ||
        parsedJSON;
      if (errorObj) {
        let msg = "";
        if (typeof errorObj === "string") {
          msg = errorObj;
        } else if (typeof errorObj === "object" && errorObj !== null) {
          msg =
            errorObj.message ||
            errorObj.detail ||
            errorObj.error ||
            (errorObj.toString ? errorObj.toString() : "");
          if (msg === "[object Object]") {
            // Serialize the object or pick its values
            msg = JSON.stringify(errorObj);
          }
        }

        if (msg) {
          const code =
            typeof errorObj === "object" && errorObj !== null && errorObj.code
              ? ` (Code: ${errorObj.code})`
              : "";
          return `${msg}${code}`;
        }
      }
    }
  } catch (e) {
    // Fall back to HTML regex parsing
  }

  let title = "";
  let h1 = "";
  let detail = "";

  try {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) title = titleMatch[1].trim();

    const h1Match = html.match(/<h1>([^<]+)<\/h1>/i);
    if (h1Match?.[1]) h1 = h1Match[1].trim();

    const pMatch = html.match(/<p>([^<]+)<\/p>/i);
    if (pMatch?.[1]) detail = pMatch[1].trim();
  } catch (e) {
    // ignore
  }

  const statusText = `HTTP Status: ${status}`;
  const parsed = [title, h1, detail].filter(Boolean).join(" | ");

  if (parsed) {
    return `${statusText} - ${parsed}`;
  }

  return `${statusText} - ${html.substring(0, 200).replace(/\s+/g, " ")}...`;
}

/**
 * Verify if the API key is valid by checking the configurations endpoint
 */
export async function verifyApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  try {
    // Configurations is a solid v2 endpoint requiring X-API-Key
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/v2/configurations`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
    });
    return response.ok;
  } catch (err) {
    console.warn("Error verifying Cleanvoice API key:", err);
    return false;
  }
}

/**
 * Record job ID to localStorage to ensure it is kept track of for cleanup
 */
export function recordCleanvoiceJob(editId: string) {
  if (typeof window === "undefined") return;
  try {
    const historyJson = localStorage.getItem("cleanvoice_job_history") || "[]";
    const history = JSON.parse(historyJson) as string[];
    if (!history.includes(editId)) {
      history.push(editId);
      localStorage.setItem("cleanvoice_job_history", JSON.stringify(history));
    }
  } catch (e) {
    console.warn("Failed to record Cleanvoice job history", e);
  }
}

/**
 * Remove job ID from localStorage tracking once deleted safely
 */
export function removeCleanvoiceJobRecord(editId: string) {
  if (typeof window === "undefined") return;
  try {
    const historyJson = localStorage.getItem("cleanvoice_job_history") || "[]";
    let history = JSON.parse(historyJson) as string[];
    history = history.filter((id) => id !== editId);
    localStorage.setItem("cleanvoice_job_history", JSON.stringify(history));
  } catch (e) {
    console.warn("Failed to remove Cleanvoice job history", e);
  }
}

/**
 * Utility to clean up older/historical Cleanvoice jobs
 * stored in localStorage. Typically called on clear queue or session end.
 */
export async function cleanupOldCleanvoiceEdits(
  apiKey: string,
  keepalive: boolean = false,
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const historyJson = localStorage.getItem("cleanvoice_job_history");
    if (!historyJson) return;
    const history = JSON.parse(historyJson) as string[];
    if (history.length === 0) return;

    // Use Promise.all if not in keepalive, or just fire and forget if keepalive
    for (const editId of history) {
      const baseUrl = getBaseUrl();
      if (keepalive) {
        // Fire and forget when page is unmounting
        fetch(`${baseUrl}/v2/edits/${editId}`, {
          method: "DELETE",
          headers: getHeaders(apiKey),
          keepalive: true,
        }).catch(() => {});
      } else {
        // Standard cleanup (e.g. from Clear Queue button)
        try {
          const response = await fetch(`${baseUrl}/v2/edits/${editId}`, {
            method: "DELETE",
            headers: getHeaders(apiKey),
          });

          if (
            response.ok ||
            response.status === 404 ||
            response.status === 410
          ) {
            removeCleanvoiceJobRecord(editId);
          }
        } catch (err) {
          console.warn(
            `Silently ignoring failure to delete older job ${editId}`,
            err,
          );
        }
      }
    }

    if (keepalive) {
      // Optimistically clear the keepalive history once the DELETE requests
      // are queued. Previously this branch never pruned localStorage, so failed
      // fire-and-forget deletes left orphan edit IDs accumulating forever
      // (re-attempted on every subsequent cleanup with no bound).
      try {
        localStorage.removeItem("cleanvoice_job_history");
      } catch (e) {
        console.warn("Failed to clear keepalive Cleanvoice job history", e);
      }
    }
  } catch (e) {
    console.warn("Failed to process Cleanvoice cleanup", e);
  }
}

/**
 * Trigger file upload to Cleanvoice and start edit process
 * This performs:
 * 1. POST /v2/upload to get a signed upload URL
 * 2. PUT to signed URL to upload raw binary data
 * 3. POST /v2/edits with the uploaded file reference and config
 *
 * Returns the edit ID.
 */
/**
 * Request a fresh presigned PUT URL from Cleanvoice for `fileName`. Routed
 * through getBaseUrl() (the /api/cleanvoice proxy on Vercel) so the API-key
 * sign request shares the proxy's IP — a browser IP flagged by Cleanvoice from
 * earlier direct-polling abuse returned 401 even for valid keys. The binary
 * PUT still goes direct to GCS. Throws on auth/credit/exhaustion errors.
 */
async function requestSignedUrl(
  fileName: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string> {
  const signRes = await fetch(
    `${getBaseUrl()}/v2/upload?filename=${encodeURIComponent(fileName)}`,
    { method: "POST", headers: { "X-API-Key": apiKey }, signal }
  );

  if (!signRes.ok) {
    let errorText = "";
    try { errorText = await signRes.text(); } catch (e) {}
    checkCreditExhaustion(signRes.status, errorText);
    if (signRes.status === 401 || errorText.includes("Invalid API Key")) {
      throw new Error(`Invalid Cleanvoice API Key. Please click the Settings gear to update it.`);
    }
    throw new Error(`Failed to initialize direct upload: ${signRes.status} ${signRes.statusText} - ${errorText}`);
  }

  const signData = await signRes.json();
  const signedUrl = signData.signedUrl || signData.url;
  if (!signedUrl) throw new Error("Did not receive a signed URL from Cleanvoice.");
  return signedUrl;
}

/**
 * PUT a binary body to a URL using XMLHttpRequest so we get REAL byte-level
 * upload progress (fetch exposes no upload-progress event). Reports progress via
 * onProgress, only on integer-percent change to avoid log/state spam. Wires
 * signal → xhr.abort() to preserve the existing cancel behavior. Resolves on
 * 2xx; on non-2xx rejects with an Error carrying `.status`; on network failure
 * `.status = -1`; on abort `.status = 0`.
 */
function xhrPut(
  url: string,
  body: Blob | File,
  signal: AbortSignal | undefined,
  onProgress: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", body.type || "application/octet-stream");

    let lastPct = -1;
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        const e: any = new Error(`Upload PUT failed: status ${xhr.status}`);
        e.status = xhr.status;
        reject(e);
      }
    };
    xhr.onerror = () => {
      const e: any = new Error("Upload PUT network error");
      e.status = -1;
      reject(e);
    };
    xhr.onabort = () => {
      // Match the DOMException name callers already detect ("AbortError") so
      // the cancel flow treats this as an abort, not a hard failure.
      const e: any = new Error("Upload aborted");
      e.name = "AbortError";
      e.status = 0;
      reject(e);
    };

    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(body);
  });
}

/**
 * Upload a file to Cleanvoice via the server's parallel chunked relay
 * (/api/uploads). The browser sends the file in N concurrent 8 MB chunks; the
 * server assembles them in memory (no disk I/O), signs a presigned URL, and
 * relays the assembled buffer to GCS with native fetch — higher throughput
 * than a single browser XHR (which is capped by a single TCP stream + browser
 * throttling). Only used on localhost where the full Express backend runs as a
 * single process — the in-memory activeUploads Map is per-process, so on
 * multi-instance hosts (Cloud Run) parallel chunks could land on different
 * instances and never assemble.
 *
 * Returns the public GCS URL (the signed URL minus query params).
 */
async function parallelChunkedUpload(
  fileToUpload: File | Blob,
  fileName: string,
  apiKey: string,
  onLog?: (msg: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const log = (msg: string) => onLog?.(msg);
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk keeps each request small and memory-friendly
  // TIER 1 — raised 5 -> 8 in-flight chunks. More parallel TCP streams recover
  // more of the available bandwidth on high-latency links, where a single
  // stream is window-limited rather than bandwidth-limited.
  //
  // Chunk size is deliberately left at 8 MB: server-side peak memory is
  // roughly CONCURRENCY x CHUNK_SIZE per upload, so 8 x 8 MB = ~64 MB is an
  // acceptable ceiling, whereas raising both would risk OOM on small
  // instances. This only helps if the client's uplink is the bottleneck — it
  // does nothing for Cleanvoice's own processing time.
  const CONCURRENCY = 8;
  const MAX_CHUNK_RETRIES = 2;

  const totalSize = fileToUpload.size;
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
  const fileId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

  log(`[Upload] Parallel relay: ${totalChunks} chunk(s) × 8MB, concurrency ${Math.min(CONCURRENCY, totalChunks)}`);

  let remoteUrl: string | undefined;
  let acknowledged = 0;

  const sendChunk = async (chunkIndex: number): Promise<void> => {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = fileToUpload.slice(start, end);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      if (signal?.aborted) {
        const e: any = new Error("Upload aborted");
        e.name = "AbortError";
        throw e;
      }
      try {
        // Build a fresh FormData per attempt — the body is serialized on send,
        // and a Blob slice can be re-read, so this is safe across retries.
        const formData = new FormData();
        formData.append("fileId", fileId);
        formData.append("chunkIndex", String(chunkIndex));
        formData.append("totalChunks", String(totalChunks));
        formData.append("filename", safeFileName);
        formData.append("chunk", chunk, safeFileName);

        const res = await fetch("/api/uploads", {
          method: "POST",
          headers: { "x-api-key": apiKey },
          body: formData,
          signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Chunk ${chunkIndex} rejected: ${res.status} ${errText}`);
        }
        const data = await res.json().catch(() => ({}));
        // Exactly one chunk — the one whose arrival completes assembly —
        // returns { complete: true, remoteUrl }. The rest return
        // { complete: false, chunkIndex } and are acknowledged immediately
        // (the server stores the chunk and responds without waiting for GCS).
        if (data.complete && data.remoteUrl) {
          remoteUrl = data.remoteUrl as string;
          return;
        }
        acknowledged++;
        const pct = Math.min(95, Math.round((acknowledged / totalChunks) * 95));
        log(`[Upload] ${pct}% complete`);
        return;
      } catch (err: any) {
        if (err?.name === "AbortError" || signal?.aborted) throw err;
        lastErr = err;
        if (attempt < MAX_CHUNK_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Chunk ${chunkIndex} failed after ${MAX_CHUNK_RETRIES + 1} attempts`);
  };

  // Concurrency-limited worker pool over chunk indices 0..totalChunks-1.
  // Workers pull the next index until all chunks are sent or one returns the
  // completing remoteUrl (which stops the remaining workers).
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < totalChunks && !remoteUrl && !signal?.aborted) {
      const idx = nextIndex++;
      await sendChunk(idx);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, totalChunks); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (signal?.aborted) {
    const e: any = new Error("Upload aborted");
    e.name = "AbortError";
    throw e;
  }
  if (!remoteUrl) {
    throw new Error(
      "Parallel upload completed without a remote URL — server assembly may have failed."
    );
  }
  log(`[Upload] 100% complete`);
  log(`[Upload] Stream synced and verified: ${remoteUrl}`);
  return remoteUrl;
}

export async function streamMediaChunksParallel(
  fileToUpload: File | Blob,
  fileName: string,
  apiKey: string,
  onLog?: (msg: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const log = (msg: string) => onLog?.(msg);

  if ((fileToUpload as any).remoteUrl) {
    log(`[Upload Phase] Awaiting original uncompressed background upload stream...`);
    return (fileToUpload as any).remoteUrl;
  }

  if (!fileName.includes('.')) {
    if (fileToUpload.type.includes('webm')) fileName += '.webm';
    else if (fileToUpload.type.includes('mp3')) fileName += '.mp3';
    else if (fileToUpload.type.includes('wav')) fileName += '.wav';
    else fileName += '.webm';
  }

  // --- FASTER PATH: Parallel Chunked Upload through server-side in-memory relay ---
  // Only trigger for files larger than 1.5MB to avoid overhead, and only if server is active.
  if (hasServerBackend() && fileToUpload.size > 1.5 * 1024 * 1024) {
    try {
      log(`Step 1/3: Dispatching high-performance parallel chunked upload via local relay...`);
      const remoteUrl = await parallelChunkedUpload(
        fileToUpload,
        fileName,
        apiKey,
        onLog,
        signal
      );
      if (remoteUrl) {
        log(`[Upload] Parallel chunked upload completed successfully via relay!`);
        return remoteUrl;
      }
    } catch (chunkErr: any) {
      log(`[Upload] Parallel chunked upload fell back (${chunkErr.message || chunkErr}). Reverting to single-stream direct GCS upload...`);
    }
  }

  log(`Step 1/3: POSTing to https://api.cleanvoice.ai/v2/upload registered file metadata...`);

  const signedUrl = await requestSignedUrl(fileName, apiKey, signal);

  // 2. Transmit to Cloud Edge using a streaming PUT. XHR (not fetch) is used so
  //    we get real byte-level upload progress — fetch exposes no upload event.
  log(`Step 2/3: Uploading binary data (${(fileToUpload.size / (1024 * 1024)).toFixed(1)}MB) to secure GCS bucket...`);

  const reportProgress = (pct: number) => log(`[Upload] ${pct}% complete`);

  // Single attempt — deliberately NO retry/backoff loop. Re-signing + retrying
  // the PUT on a 429 would consume Cleanvoice's per-key rate-limit budget (the
  // same budget the /v2/edits processing poller shares) and the backoff would
  // delay the upload, both of which cascade into slower processing detection
  // (the 43s→62s regression). The previous single-shot fetch PUT was the fast
  // baseline; we keep single-shot behavior and only swap fetch→XHR for progress.
  try {
    await xhrPut(signedUrl, fileToUpload, signal, reportProgress);
  } catch (err: any) {
    // A user cancel propagates immediately
    if (err?.status === 0 || err?.name === "AbortError") throw err;

    log(`[Upload] Direct upload failed (${err.message || err}).`);
    throw err;
  }

  const publicUrl = signedUrl.split("?")[0];
  log(`[Upload] Stream synced and verified: ${publicUrl}`);
  return publicUrl;
}

export async function startCleanvoiceEdit(
  fileOrFiles: (File | Blob) | (File | Blob)[],
  config: CleanvoiceConfig,
  apiKey: string,
  onLog?: (message: string) => void,
  signal?: AbortSignal
): Promise<{ editId: string; publicUrl: string }> {
  const log = (msg: string) => onLog?.(msg);

  const filesArray = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (filesArray.length === 0) {
    throw new Error("No files provided for Cleanvoice edit.");
  }

  // If every file was already uploaded in the background (its remoteUrl is set),
  // skip the upload-phase UI entirely. The processing tab should go straight to
  // "processing" — re-showing "Uploading" for work the background already
  // finished is redundant and makes the flow feel slower than it is.
  const allPreUploaded = filesArray.every((f) => !!(f as any).remoteUrl);

  if (!allPreUploaded) {
    log(`Step 1/3: POSTing to https://api.cleanvoice.ai/v2/upload registered file metadata...`);
  }

  const uploadStart = Date.now();

  // Upload all tracks in parallel instead of one-by-one. For multitrack edits
  // this turns serial N×(upload latency) into a single round of concurrent uploads.
  // The per-file work (await a pre-existing background uploadPromise, or fall back
  // to streamMediaChunksParallel) is identical to the previous serial loop.
  const urls: string[] = await Promise.all(
    filesArray.map(async (fileToUpload, i) => {
      const fileName =
        "name" in fileToUpload
          ? (fileToUpload as File).name
          : `recorded_audio_${i}.webm`;

      let publicUrl = (fileToUpload as any).remoteUrl as string;

      if (!publicUrl && (fileToUpload as any).uploadPromise) {
        log(`[Upload Phase] Awaiting original uncompressed background upload stream...`);
        publicUrl = await (fileToUpload as any).uploadPromise;
      }

      if (!publicUrl) {
        publicUrl = await streamMediaChunksParallel(fileToUpload, fileName, apiKey, log, signal);
      }
      return publicUrl;
    }),
  );

  const uploadElapsedSec = Math.max(0, (Date.now() - uploadStart) / 1000).toFixed(1);

  if (!allPreUploaded) {
    log(`Step 3/3: Requesting job edit compilation: POST to v2/edits with standard configs... [100% complete]`);
    log(`[Upload Phase Completed] Uploading took ${uploadElapsedSec} seconds.`);
  }

  // Adapt config keys to Cleanvoice API structures with minimized payload size
  const editApiConfig: any = {};
  if (config.fillers) editApiConfig.fillers = true;
  if (config.stutters) editApiConfig.stutters = true;
  if (config.silences) editApiConfig.long_silences = true;
  if (config.hesitations) editApiConfig.hesitations = true;
  if (config.mouth_sounds) editApiConfig.mouth_sounds = true;
  if (config.mute) editApiConfig.muted = true;
  if (config.noise === "v2" || config.noise === "legacy") {
    editApiConfig.remove_noise = config.noise;
  } else if (config.noise) {
    editApiConfig.remove_noise = true;
  }
  if (config.normalize) editApiConfig.normalize = config.normalize;
  if (config.eq) {
    if (!config.studio_sound || config.studio_sound === "disabled") {
      editApiConfig.autoeq = config.eq;
    }
  }
  // Transcription and summarisation explicitly disabled for maximum processing speed
  editApiConfig.transcription = false;
  editApiConfig.summarize = false;
  editApiConfig.social_content = false;
  if (config.keep_music) editApiConfig.keep_music = true;

  if (config.remove_breath && config.remove_breath !== "disabled") {
    if (config.remove_breath === "natural" || config.remove_breath === "legacy") {
      editApiConfig.breath = config.remove_breath;
    } else {
      editApiConfig.breath = true;
    }
  }

  if (config.studio_sound && config.studio_sound !== "disabled") {
    if (config.studio_sound === "standard" || config.studio_sound === true) {
      editApiConfig.studio_sound = true;
    } else if (config.studio_sound === "nightly") {
      editApiConfig.studio_sound = "nightly";
    } else if (config.studio_sound === "javelin") {
      editApiConfig.studio_sound = "javelin";
    } else {
      editApiConfig.studio_sound = config.studio_sound;
    }
  }

  if (config.start_time !== undefined) editApiConfig.start_time = config.start_time;
  if (config.end_time !== undefined) editApiConfig.end_time = config.end_time;

  const chosenFormat = config.format || "mp3";
  const chosenBitrate = config.targetBitrate || "128";
  const targetBitrateValue = (!chosenBitrate || chosenBitrate.toLowerCase() === "source")
    ? null
    : parseInt(chosenBitrate) * 1000;

  editApiConfig.export = {
    format: chosenFormat,
    bitrate: targetBitrateValue
  };

  const payload: any = {
    input: {
      files: urls,
      config: editApiConfig,
    }
  };

  if (urls.length > 1) {
    payload.input.upload_type = "multitrack";
  }

  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}/v2/edits`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    let raw = await response.text();
    let errCode = response.status.toString();
    checkCreditExhaustion(response.status, raw);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.error && parsed.error.message) raw = parsed.error.message;
        else if (parsed.message) raw = parsed.message;
        else raw = JSON.stringify(parsed);
      }
    } catch (e) {}
    throw new Error(`Cleanvoice API error (Status ${errCode}): ${raw}`);
  }

  const editData = await response.json();
  const editId = editData.editId || editData.id || editData.edit_id;

  if (editId) {
    recordCleanvoiceJob(editId);
  }

  return { editId, publicUrl: "https://api.cleanvoice.ai" };
}

/**
 * Poll for job completion Status
 */
export async function getCleanvoiceEditStatus(
  editId: string,
  apiKey: string,
): Promise<CleanvoiceJobStatus> {
  const baseUrl = getBaseUrl();
  const response = await fetch(
    `${baseUrl}/v2/edits/${editId}?_t=${Date.now()}`,
    {
      method: "GET",
      headers: getHeaders(apiKey),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    if (response.status === 429) {
      // Return processing status on rate limit instead of throwing error
      return {
        id: editId,
        status: "processing",
        progressPercentage: undefined,
        isRateLimited: true,
      };
    }
    const errText = await response.text();
    checkCreditExhaustion(response.status, errText);
    const parsedMsg = parseHtmlError(errText, response.status);
    throw new Error(
      `Failed to retrieve job status for ID ${editId}. Error: ${parsedMsg}`,
    );
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const parsedMsg = parseHtmlError(text, response.status);
    if (
      parsedMsg.includes("Starting Server") ||
      parsedMsg.includes("Please wait")
    ) {
      return {
        id: editId,
        status: "processing",
        progressPercentage: undefined,
      };
    }
    throw new Error(
      `Transient proxy error or invalid response (${parsedMsg}). Retrying...`,
    );
  }

  // Extract progress details according to official JS SDK structure
  let progressPercentage: number | undefined = undefined;
  let rawStatusText = (data.status || "").toString().toLowerCase();

  const statusContainer = data.results || data.result;
  if (statusContainer && typeof statusContainer === "object") {
    if ("done" in statusContainer) {
      const doneField = statusContainer.done;
      // `done` may be a boolean completion flag rather than a numeric fraction.
      // Handle the boolean case explicitly before attempting parseFloat.
      if (typeof doneField === "boolean") {
        progressPercentage = doneField ? 100 : progressPercentage;
      } else {
        const doneVal = parseFloat(doneField);
        if (!isNaN(doneVal)) {
          progressPercentage = doneVal <= 1 ? doneVal * 100 : doneVal;
        }
      }
    }
    if (
      "state" in statusContainer &&
      typeof statusContainer.state === "string"
    ) {
      rawStatusText = statusContainer.state.toLowerCase();
    } else if (
      "task" in statusContainer &&
      typeof statusContainer.task === "string"
    ) {
      rawStatusText = statusContainer.task.toLowerCase();
    }
  }

  // Detect if the job is officially in a queued or waiting state
  const isQueued =
    rawStatusText === "queued" ||
    rawStatusText === "waiting" ||
    rawStatusText === "pending" ||
    data.isQueued === true ||
    (data.status && ["queued", "waiting", "pending"].includes(data.status.toString().toLowerCase())) ||
    (statusContainer && typeof statusContainer === "object" && (
      (statusContainer.state && ["queued", "waiting", "pending"].includes(statusContainer.state.toString().toLowerCase())) ||
      (statusContainer.status && ["queued", "waiting", "pending"].includes(statusContainer.status.toString().toLowerCase())) ||
      (statusContainer.task && ["queued", "waiting", "pending"].includes(statusContainer.task.toString().toLowerCase()))
    ));

  // Normalize/eliminate any queue status (e.g. queued, waiting, pending) to accelerate immediately
  if (rawStatusText === "queued" || rawStatusText === "waiting" || rawStatusText === "pending") {
    rawStatusText = "processing";
  }

  // Preserve 'rawStatus' as uppercase to present nicely in UI like [PREPROCESSING]
  let rawStatus = isQueued ? "QUEUED" : rawStatusText.toUpperCase();
  if (rawStatus === "PROCESSING" || rawStatus === "") {
    if (typeof data.info === "string") rawStatus = data.info.toUpperCase();
    else if (typeof data.message === "string")
      rawStatus = data.message.toUpperCase();
    else if (typeof data.step === "string") rawStatus = data.step.toUpperCase();
    else if (typeof data.state === "string")
      rawStatus = data.state.toUpperCase();
  }

  let errorMsg: string | undefined = undefined;
  if (data) {
    if (data.error) {
      if (typeof data.error === "object") {
        errorMsg = data.error.message || data.error.code || JSON.stringify(data.error);
      } else {
        errorMsg = String(data.error);
      }
    } else if (data.errorMessage) {
      errorMsg = String(data.errorMessage);
    } else if (data.errors) {
      errorMsg = typeof data.errors === "string" ? data.errors : JSON.stringify(data.errors);
    }
  }

  let normalizedStatus: "processing" | "success" | "error" = "processing";

  const lowerStatus = (data.status || "").toString().toLowerCase();
  if (
    rawStatusText === "success" ||
    rawStatusText === "successful" ||
    rawStatusText === "completed" ||
    rawStatusText === "done" ||
    rawStatusText === "finished" ||
    lowerStatus === "success"
  ) {
    normalizedStatus = "success";
  } else if (
    rawStatusText === "failed" ||
    rawStatusText === "error" ||
    rawStatusText === "canceled" ||
    rawStatusText === "cancelled" ||
    rawStatusText === "failure" ||
    lowerStatus === "failed" ||
    lowerStatus === "failure" ||
    lowerStatus === "error" ||
    errorMsg !== undefined
  ) {
    normalizedStatus = "error";
  } else {
    // The top-level status is authoritative; no other in-flight state is recognized.
    normalizedStatus = "processing";
  }

  let download_url =
    data.download_url ||
    data.downloadUrl ||
    data.audio?.url ||
    data.audio?.download_url ||
    data.audio?.output_url ||
    data.result?.audio?.url ||
    data.results?.audio?.url ||
    data.output_url ||
    data.result_url ||
    data.audio_url ||
    data.cleaned_url ||
    (data.results &&
      (data.results.download_url ||
        data.results.downloadUrl ||
        data.results.export_url ||
        data.results.url ||
        data.results.output_url ||
        data.results.audio_url ||
        (Array.isArray(data.results.files) && data.results.files[0]))) ||
    (data.result &&
      (data.result.download_url ||
        data.result.downloadUrl ||
        data.result.export_url ||
        data.result.url ||
        data.result.output_url ||
        data.result.audio_url ||
        (Array.isArray(data.result.files) && data.result.files[0]))) ||
    (data.export &&
      (data.export.url ||
        data.export.download_url ||
        data.export.output_url ||
        (data.export.results && data.export.results.download_url))) ||
    data.url ||
    data.export_url;

  // Add recursive deep scan for URL anywhere in the JSON to robustly handle API format changes
  if (!download_url) {
    const deepSearchUrl = (obj: any): string | null => {
      if (!obj) return null;
      if (typeof obj === "string") {
        if ((obj.startsWith("http") || obj.startsWith("//")) &&
           (obj.includes(".mp3") || obj.includes(".wav") || obj.includes(".m4a") || obj.includes(".flac") || obj.includes("cleanvoice") || obj.includes("cdn") || obj.includes("storage"))) {
          return obj;
        }
        return null;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const res = deepSearchUrl(item);
          if (res) return res;
        }
      } else if (typeof obj === "object") {
        // prioritize keys that look like url
        for (const key of ["download_url", "url", "audio_url", "export_url", "output_url", "file", "audio"]) {
           if (obj[key]) {
             if (typeof obj[key] === "string" && obj[key].startsWith("http")) return obj[key];
             const res = deepSearchUrl(obj[key]);
             if (res) return res;
           }
        }
        for (const key of Object.keys(obj)) {
          const res = deepSearchUrl(obj[key]);
          if (res) return res;
        }
      }
      return null;
    };
    download_url = deepSearchUrl(data.results || data.result) || deepSearchUrl(data) || "";
  }

  // Calculate progress percentage and stage strictly by mapping the real-time stage from Cleanvoice API
  let explicitProgress: number | undefined = undefined;
  const numericFields = [
    data?.progress,
    data?.percentage,
    data?.progressPercentage,
    data?.result?.progress,
    data?.results?.progress,
    data?.result?.percentage,
    data?.results?.percentage,
    data?.task_progress,
    data?.step_progress,
    data?.export?.progress,
    data?.export?.percentage,
  ];
  for (const val of numericFields) {
    if (typeof val === "number" && !isNaN(val)) {
      explicitProgress = val <= 1.0 ? Math.round(val * 100) : Math.round(val);
      break;
    } else if (typeof val === "string" && val.trim() !== "") {
      const num = parseFloat(val);
      if (!isNaN(num)) {
        explicitProgress = num <= 1.0 ? Math.round(num * 100) : Math.round(num);
        break;
      }
    }
  }

  const stageCandidates: string[] = [];
  const checkAndPushStage = (val: any) => {
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (
        lower &&
        lower !== "processing" &&
        lower !== "pending" &&
        lower !== "queued" &&
        lower !== "waiting" &&
        lower !== "running" &&
        lower !== "started" &&
        lower !== "success"
      ) {
        stageCandidates.push(val);
      }
    }
  };

  if (data) {
    checkAndPushStage(data.step);
    checkAndPushStage(data.stage);
    checkAndPushStage(data.task);
    checkAndPushStage(data.info);
    checkAndPushStage(data.message);
    checkAndPushStage(data.status_message);
    checkAndPushStage(data.sub_status);

    const statusObj = data.results || data.result;
    if (statusObj && typeof statusObj === "object") {
      checkAndPushStage(statusObj.step);
      checkAndPushStage(statusObj.stage);
      checkAndPushStage(statusObj.task);
      checkAndPushStage(statusObj.info);
      checkAndPushStage(statusObj.message);
      checkAndPushStage(statusObj.status_message);
      checkAndPushStage(statusObj.sub_status);
    }

    if (data.export && typeof data.export === "object") {
      checkAndPushStage(data.export.step);
      checkAndPushStage(data.export.stage);
      checkAndPushStage(data.export.status);
      checkAndPushStage(data.export.info);
      checkAndPushStage(data.export.message);
    }
  }

  const combinedText = stageCandidates.join(" ").toLowerCase();
  let stageTitle = "Preprocessing audio file...";

  if (normalizedStatus === "success" && download_url) {
    progressPercentage = 100;
    stageTitle = "Processing complete!";
  } else if (isQueued) {
    progressPercentage = 5;
    stageTitle = "Waiting in queue. We will start soon...";
  } else if (explicitProgress !== undefined) {
    progressPercentage = Math.max(12, Math.min(99, explicitProgress));
    if (progressPercentage >= 84) stageTitle = "Finishing touches...";
    else if (progressPercentage >= 50) stageTitle = "Editing your audio file...";
    else if (progressPercentage >= 30) stageTitle = "Searching fillers, background noise...";
    else stageTitle = "Preprocessing audio file...";
  } else {
    if (
      combinedText.includes("finishing") ||
      combinedText.includes("export") ||
      combinedText.includes("render") ||
      combinedText.includes("touch") ||
      combinedText.includes("almost") ||
      combinedText.includes("complete") ||
      combinedText.includes("encoding")
    ) {
      progressPercentage = 84;
      stageTitle = "Finishing touches...";
    } else if (
      combinedText.includes("editing") ||
      combinedText.includes("edit") ||
      combinedText.includes("compile") ||
      combinedText.includes("cutting") ||
      combinedText.includes("mixing") ||
      combinedText.includes("stutter") ||
      combinedText.includes("autoeq") ||
      combinedText.includes("studio_sound")
    ) {
      progressPercentage = 50;
      stageTitle = "Editing your audio file...";
    } else if (
      combinedText.includes("searching") ||
      combinedText.includes("search") ||
      combinedText.includes("filler") ||
      combinedText.includes("background") ||
      combinedText.includes("noise") ||
      combinedText.includes("analyze") ||
      combinedText.includes("analysis") ||
      combinedText.includes("transcrib") ||
      combinedText.includes("speech") ||
      combinedText.includes("detecting")
    ) {
      progressPercentage = 30;
      stageTitle = "Searching fillers, background noise...";
    } else if (
      combinedText.includes("preprocessing") ||
      combinedText.includes("preprocess") ||
      combinedText.includes("download") ||
      combinedText.includes("fetching") ||
      combinedText.includes("loading") ||
      combinedText.includes("preparing") ||
      combinedText.includes("converting") ||
      combinedText.includes("decoding")
    ) {
      progressPercentage = 12;
      stageTitle = "Preprocessing audio file...";
    } else {
      progressPercentage = 12;
      stageTitle = "Preprocessing audio file...";
    }
  }

  if (normalizedStatus === "success" && !download_url) {
    // If analysis is successful but export/download URL is still in flight, hold at 84% (Finishing touches)
    progressPercentage = 84;
  }

  if (normalizedStatus === "success" && !download_url) {
    // Check if export is already in progress to avoid resetting/looping rendering and getting stuck.
    // The export sub-status must be matched case-insensitively and across the full set of
    // in-progress values the v2 API emits; a narrow match left some in-flight exports looking
    // "not started" and we fired a redundant /export POST — restarting the render and roughly
    // doubling the wait (a 4-minute clip went from ~35s to ~80s). We already request the export
    // in the initial POST /v2/edits payload, so whenever an export object exists and isn't
    // terminal we must wait, not re-trigger.
    const exportStatusRaw = data.export?.status || data.export?.state;
    const exportStatus = exportStatusRaw
      ? exportStatusRaw.toString().toLowerCase()
      : "";
    const isCurrentlyExporting =
      exportStatus === "processing" ||
      exportStatus === "queued" ||
      exportStatus === "pending" ||
      exportStatus === "running" ||
      exportStatus === "started" ||
      exportStatus === "rendering" ||
      exportStatus === "in_progress" ||
      exportStatus === "in-progress" ||
      exportStatus === "working" ||
      exportStatus === "active";

    if (
      !data.export ||
      (!isCurrentlyExporting &&
        exportStatus !== "success" &&
        exportStatus !== "completed")
    ) {
      // Dedupe + grace: the initial POST /v2/edits payload already requests an
      // export, so on the first success-without-URL the render is usually already
      // in flight and the `export` object simply hasn't appeared in the status
      // response yet. Firing a fallback /export POST here restarts the render and
      // roughly doubles the wait.
      //
      // Through the /api/cleanvoice proxy, the server-side background poller is
      // the authoritative export trigger — it dedupes against its own cache and
      // only fires /export when the auto-render genuinely didn't start. The
      // client must NOT also fire one through the proxy, or it races the server
      // poller's trigger and can restart the render. So this client-side trigger
      // runs ONLY on the direct-API path (static hosts / no backend).
      const isDirectApi = getBaseUrl() === "https://api.cleanvoice.ai";
      const ticks = (exportGraceTicks.get(editId) ?? 0) + 1;
      exportGraceTicks.set(editId, ticks);
      if (isDirectApi && ticks >= 2 && !exportTriggeredEdits.has(editId)) {
        exportTriggeredEdits.add(editId);
      // If it's SUCCESS but no url, try to call export endpoint (usually for v2)
      try {
        console.log(
          `Triggering export rendering for edit ${editId} (State: ${exportStatus || "not started"})`,
        );
        const exportRes = await fetch(
          `${baseUrl}/v2/edits/${editId}/export`,
          {
            method: "POST",
            headers: {
              "X-API-Key": apiKey || "",
            },
          },
        );
        if (exportRes.ok) {
          const exportData = await exportRes.json();
          download_url =
            exportData.download_url ||
            exportData.url ||
            exportData.export_url ||
            (exportData.results && exportData.results.download_url) ||
            (exportData.result && exportData.result.download_url) ||
            download_url;
        }
      } catch (e) {
        // Ignored
      }
      }
    }

    // A download URL means the result is ready — resolve to success immediately,
    // even if the nested export sub-status hasn't flipped to "success" yet (it can
    // lag behind the URL). Only keep polling when we don't have a URL yet.
    if (!download_url) {
      normalizedStatus = "processing";
    }
  }

  let editsArray:
    | Array<{ start: number; end: number; type: string }>
    | undefined = undefined;
  if (data.results?.edits && Array.isArray(data.results.edits)) {
    editsArray = data.results.edits;
  } else if (data.edits && Array.isArray(data.edits)) {
    editsArray = data.edits;
  }

  const results = data.results || data.result || data.export || {};

  // Safely extract remaining credits with fallbacks
  let remainingCredits: number | undefined = undefined;
  if (data) {
    if (typeof data.credits === "number") {
      remainingCredits = data.credits;
    } else if (typeof data.credits === "string") {
      const parsed = parseFloat(data.credits);
      if (!isNaN(parsed)) remainingCredits = parsed;
    } else if (data.credits_remaining !== undefined) {
      if (typeof data.credits_remaining === "number") {
        remainingCredits = data.credits_remaining;
      } else if (typeof data.credits_remaining === "string") {
        const parsed = parseFloat(data.credits_remaining);
        if (!isNaN(parsed)) remainingCredits = parsed;
      }
    } else if (data.user && typeof data.user === "object") {
      if (typeof data.user.credits === "number") {
        remainingCredits = data.user.credits;
      } else if (typeof data.user.credits === "string") {
        const parsed = parseFloat(data.user.credits);
        if (!isNaN(parsed)) remainingCredits = parsed;
      } else if (data.user.usage && typeof data.user.usage === "object") {
        if (typeof data.user.usage.credits === "number") {
          remainingCredits = data.user.usage.credits;
        } else if (typeof data.user.usage.credits === "string") {
          const parsed = parseFloat(data.user.usage.credits);
          if (!isNaN(parsed)) remainingCredits = parsed;
        }
      }
    }
  }

  // Once we have a download URL the export is resolved; drop the dedup entry
  // so the set doesn't grow unbounded over a long session.
  if (download_url) {
    exportTriggeredEdits.delete(editId);
    exportGraceTicks.delete(editId);
  }

  return {
    id: data.id || editId,
    status: normalizedStatus,
    rawStatus: rawStatus,
    progressPercentage: progressPercentage,
    download_url: download_url,
    error: errorMsg,
    edits: editsArray,
    transcription:
      typeof data.transcription === "string"
        ? data.transcription
        : typeof results.transcription === "string"
          ? results.transcription
          : undefined,
    summary:
      typeof data.summarize === "string"
        ? data.summarize
        : typeof results.summary === "string"
          ? results.summary
          : typeof results.summarize === "string"
            ? results.summarize
            : undefined,
    social_content:
      typeof data.social_content === "string"
        ? data.social_content
        : typeof results.social_content === "string"
          ? results.social_content
          : undefined,
    duration:
      typeof data.length_audio === "number"
        ? data.length_audio * 1000
        : undefined,
    createdAt: data.created_at || data.started_at,
    serverElapsedSeconds: data.server_elapsed_seconds,
    remainingCredits: remainingCredits,
    isQueued: isQueued,
  };
}

function findCreditsInObject(obj: any): number | undefined {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === "number") return obj;
  if (typeof obj === "string") {
    const val = parseFloat(obj);
    if (!isNaN(val)) return val;
  }

  // Check direct keys first for highest accuracy
  const priorityKeys = ["credits", "credits_remaining", "remaining", "balance", "amount", "minutes", "minutes_remaining", "creditsRemaining", "total"];
  for (const key of priorityKeys) {
    if (obj[key] !== undefined) {
      if (typeof obj[key] === "number") return obj[key];
      if (typeof obj[key] === "string") {
        const val = parseFloat(obj[key]);
        if (!isNaN(val)) return val;
      }
      if (typeof obj[key] === "object") {
        const nested = findCreditsInObject(obj[key]);
        if (nested !== undefined) return nested;
      }
    }
  }

  // Fallback: search all other keys recursively
  for (const key in obj) {
    if (!priorityKeys.includes(key) && typeof obj[key] === "object") {
      const nested = findCreditsInObject(obj[key]);
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}

/**
 * Fetch remaining credits dynamic balance from Account API
 */
export async function getCleanvoiceAccountCredits(
  apiKey: string,
): Promise<number | undefined> {
  if (!apiKey) return undefined;
  try {
    const showConsoleLogs = typeof window !== "undefined";
    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/v1/account`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
      },
    });
    if (showConsoleLogs) {
      console.log(`[Cleanvoice API] Account status response: ${response.status} ${response.statusText}`);
    }
    if (!response.ok) return undefined;
    const data = await response.json();
    if (showConsoleLogs) {
      console.log("[Cleanvoice API] Account data payload parsed successfully:", data);
    }
    
    return findCreditsInObject(data);
  } catch (err) {
    console.warn("Error checking Cleanvoice account credits:", err);
    return undefined;
  }
}

/**
 * Delete a job/edit and its associated data on Cleanvoice to protect user privacy
 */
export async function deleteCleanvoiceEdit(
  editId: string,
  apiKey: string,
  throwOnError?: boolean,
): Promise<void> {
  try {
    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/v2/edits/${editId}`, {
      method: "DELETE",
      headers: getHeaders(apiKey),
    });

    if (!response.ok) {
      if (response.status !== 404) {
        const errorMsg = `Failure to delete job ID ${editId}: ${response.statusText}`;
        console.warn(errorMsg);
        if (throwOnError) {
          throw new Error(errorMsg);
        }
      }
    } else {
      removeCleanvoiceJobRecord(editId);
    }
  } catch (err) {
    console.warn(
      `Network error during delete for job ID ${editId}`,
      err,
    );
    if (throwOnError) {
      throw err;
    }
  }
}
