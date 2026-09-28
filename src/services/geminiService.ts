// Client-side direct Google GenAI API handler

import { GoogleGenAI } from "@google/genai";
import { isAudioFile, sniffAudioContainer } from '../utils/audioUtils';
import { MemoryTracker } from '../utils/memoryTracker';
import {
  PRIMARY_GEMINI_MODEL,
  buildModelOrder,
  getThinkingConfig,
  isInvalidArgumentError,
} from './geminiModels';
import { raceTimingsFor, raceToFirstChunk } from './geminiRace';

/**
 * Encodes a contiguous slice of a byte array to a Base64 string WITHOUT relying
 * on FileReader.readAsDataURL (which materializes a full data-URL wrapper string).
 *
 * Works on arbitrary [start,end) ranges so the caller can chunk large files and
 * yield to the UI thread between chunks. A chunk whose length is a multiple of 3
 * produces no '=' padding, so concatenated chunk outputs form a valid Base64
 * stream. Only the FINAL (short) chunk may need padding, and btoa handles that
 * naturally when given its subarray.
 */
function base64EncodeChunk(bytes: Uint8Array, start: number, end: number): string {
  // btoa operates on a binary string. For a sub-slice we must build that string
  // from the byte range directly (no copy of the whole buffer). This is the same
  // primitive readAsDataURL uses internally, minus the data-URL overhead.
  let binary = '';
  for (let i = start; i < end; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export interface PerformanceLogEntry {
  event: string;
  model?: string;
  durationMs: number;
  details?: string;
  timestamp: string;
}

export const GeminiPerformanceLogger = {
  logs: [] as PerformanceLogEntry[],
  // Cap retained log entries to prevent unbounded memory growth over a long session.
  MAX_LOG_ENTRIES: 500,

  log(event: string, durationMs: number, details?: string, model?: string) {
    const logEntry = {
      event,
      model,
      durationMs: Math.round(durationMs * 100) / 100,
      details,
      timestamp: new Date().toLocaleTimeString(),
    };
    this.logs.push(logEntry);
    // Trim oldest entries once we exceed the cap.
    if (this.logs.length > this.MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - this.MAX_LOG_ENTRIES);
    }
    
    // Print a gorgeously styled, highly prominent console report message
    console.log(
      `%c[GEMINI PERFORMANCE] %c${event}%c ${model ? `(${model})` : ''} - %c${logEntry.durationMs}ms%c${details ? ` | ${details}` : ''}`,
      "color: #a855f7; font-weight: bold; background: rgba(168, 85, 247, 0.1); padding: 2px 4px; border-radius: 4px;",
      "color: #3b82f6; font-weight: 600;",
      "color: #10b981;",
      "color: #f43f5e; font-weight: bold;",
      "color: #64748b;"
    );
  },
};

const getApiKey = () => {
  if (typeof window !== "undefined") {
    // localStorage.getItem can throw (SecurityError / QuotaExceededError) in
    // Safari private mode and some sandboxed webviews; fall back to the env key.
    try {
      const localKey = localStorage.getItem("gemini_api_key");
      if (localKey) return localKey;
    } catch (e) {
      console.warn("[Gemini] localStorage unavailable, falling back to env key:", e);
    }
  }

  return (
    (typeof process !== "undefined" ? process.env?.GEMINI_API_KEY : "") ||
    ""
  );
};

/**
 * Detects client-only static hosting where `/api/health` and `/api/prewarm`
 * don't exist, so we skip those probes (they'd 404 → the SPA's "Page not
 * found" HTML, adding console noise + latency on every load).
 *
 * Vercel is NOT static: api/health.ts, api/prewarm.ts and api/process-file.ts
 * are deployed as serverless functions there.
 */
const isStaticHosting = (): boolean => {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host.includes("netlify.app") || host.includes("github.io");
};

// Vercel rejects function request bodies over 4.5 MB; leave room for the
// multipart envelope + prompt. Larger files use the direct client path.
const SERVER_ROUTE_MAX_FILE_BYTES = 4 * 1024 * 1024;

export async function prewarmGeminiClient(specificModel?: string) {
  const startPrewarm = performance.now();
  try {
    const startKeyRead = performance.now();
    const apiKey = getApiKey();
    const keyReadDuration = performance.now() - startKeyRead;
    
    if (!apiKey) {
      GeminiPerformanceLogger.log("CLIENT_PREWARM_SKIPPED", keyReadDuration, "No Gemini API Key was found in localStorage or Environment.");
      return;
    }
    
    // Automatically determine standard API key vs OAuth token
    const startClientInit = performance.now();
    const isOAuthToken = apiKey.startsWith("ya29.");
    const clientConfig: any = {};
    if (isOAuthToken) {
      clientConfig.authToken = apiKey;
    } else {
      clientConfig.apiKey = apiKey;
    }
    const ai = new GoogleGenAI(clientConfig);
    const clientInitDuration = performance.now() - startClientInit;
    GeminiPerformanceLogger.log("CLIENT_SDK_INITIALIZATION_HANDSHAKE", clientInitDuration, "Constructed GoogleGenAI SDK instance.");
    
    // No warm-up generateContent call any more: it was a real request on the
    // same key (the logs show it taking 9-47s to be rejected with 503) that
    // competed with the actual transcription for rate limit and capacity.
    // index.html preconnects to the Gemini API host instead, which gets the
    // TLS/DNS setup done without spending a request.
    void ai;

    // Trigger server-side pre-warm endpoint if possible to optimize backend instance cold-starts.
    // Skip on static hosting (Netlify/GitHub Pages): there is no serverless route there,
    // so the fetch would 404 and return the SPA "Page not found" HTML every time.
    if (isStaticHosting()) {
      GeminiPerformanceLogger.log("SERVER_PREWARM_SKIPPED_STATIC", 0, "Static hosting detected; no /api/prewarm route available.");
    } else {
      const serverPrewarmStart = performance.now();
      fetch("/api/prewarm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gemini-API-Key": apiKey
        },
        body: JSON.stringify({ model: specificModel || PRIMARY_GEMINI_MODEL })
      }).then(async (res) => {
        const duration = performance.now() - serverPrewarmStart;
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          GeminiPerformanceLogger.log("SERVER_PREWARM_ROUTE_RESOLVED", duration, `Server prewarm returned dynamic status: ${JSON.stringify(data)}`);
        } else {
          const txt = await res.text().catch(() => "");
          GeminiPerformanceLogger.log("SERVER_PREWARM_ROUTE_FAILED", duration, `Server prewarm returned HTTP ${res.status}: ${txt}`);
        }
      }).catch((err) => {
        const duration = performance.now() - serverPrewarmStart;
        GeminiPerformanceLogger.log("SERVER_PREWARM_ROUTE_ERROR", duration, `Server prewarm fetch errored: ${err.message || err}`);
      });
    }

  } catch (e: any) {
    console.warn("Gemini client pre-warm failed:", e);
    GeminiPerformanceLogger.log("PREWARM_CRITICAL_FAILURE", performance.now() - startPrewarm, `Pre-warm process encountered an unexpected exception: ${e.message || e}`);
  }
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The user aborted a request.", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("The user aborted a request.", "AbortError"));
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isClientAuthError(error: any): boolean {
  const status = Number(error?.status ?? error?.code);
  const msg = String(error?.message || error).toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    msg.includes("invalid api key") ||
    msg.includes("permission_denied") ||
    msg.includes("key not valid") ||
    msg.includes("api_key_invalid")
  );
}

function isTransientError(error: any): boolean {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  const msg = String(error.message || error).toLowerCase();
  
  if (msg.includes('permission_denied') || msg.includes('denied access') || msg.includes('status 403')) {
    return false;
  }

  // The SDK surfaces 503s as "Retryable HTTP Error:" with an empty status text,
  // so the numeric code only lives on the error object, not in the message.
  const status = Number(error.status ?? error.code ?? error.response?.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  return (
    msg.includes('retryable') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('quota') ||
    msg.includes('connection')
  );
}

let serverApiStatus: boolean | null = null;
let serverApiCheckPromise: Promise<boolean> | null = null;
let serverApiCheckedAt = 0;
const SERVER_API_TTL_MS = 5 * 60 * 1000; // re-check at most every 5 minutes

function performServerHealthCheck(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (isStaticHosting()) {
      resolve(false);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    fetch("/api/health", { signal: controller.signal })
      .then((ping) => {
        clearTimeout(timeoutId);
        if (ping.ok) {
          ping.text().then((text) => {
            resolve(text.includes('"status":"ok"') || text.includes('"status": "ok"'));
          }).catch(() => resolve(false));
        } else {
          resolve(false);
        }
      })
      .catch(() => resolve(false));
  });
}

/**
 * Returns the cached server-availability result if fresh, otherwise returns null
 * (meaning: unknown right now). Never blocks the caller. Kicks off (or reuses)
 * an in-flight health check that fills the cache for subsequent calls.
 */
function getServerApiStatusCached(): boolean | null {
  // If we have a fresh cached result, use it directly.
  if (serverApiStatus !== null && (Date.now() - serverApiCheckedAt) < SERVER_API_TTL_MS) {
    return serverApiStatus;
  }
  // Otherwise fire-and-forget the health check so the cache is ready for the
  // NEXT call, but don't block the current transcription on it.
  if (!serverApiCheckPromise) {
    serverApiCheckPromise = performServerHealthCheck().then((result) => {
      serverApiStatus = result;
      serverApiCheckedAt = Date.now();
      serverApiCheckPromise = null;
      return result;
    }).catch((err) => {
      // A rejection here (today performServerHealthCheck always resolves, but
      // guard against future changes) must not permanently stall the cache or
      // surface as an unhandled rejection. Treat it as "server unavailable".
      console.warn("[Gemini] Server health check rejected:", err);
      serverApiStatus = false;
      serverApiCheckedAt = Date.now();
      serverApiCheckPromise = null;
      return false as boolean;
    });
  }
  return null;
}

/**
 * Best-effort, NON-BLOCKING server availability check.
 *
 * Previously this was fully `await`-ed inside processFile(), which meant the
 * very first transcription of a session stalled on a /api/health round-trip
 * (up to the 2s timeout) BEFORE the upload even started. That showed up as a
 * noticeable "initial delay" that vanished for the 2nd+ transcription (because
 * the result got cached).
 *
 * Now: we use the cached value if fresh; if not, we race the in-flight check
 * against a short grace window. If the check still hasn't resolved in time, we
 * return null (= unknown) so processFile() falls through to the client-side
 * path immediately instead of waiting. The cache is filled in the background
 * for the next call.
 */
async function isServerApiAvailable(): Promise<boolean | null> {
  const cached = getServerApiStatusCached();
  if (cached !== null) return cached;

  // Unknown — give the in-flight check a short grace window, but don't block
  // long. If it doesn't resolve, let the caller proceed to the client path.
  if (serverApiCheckPromise) {
    const graceController = new AbortController();
    const graceTimeout = setTimeout(() => graceController.abort(), 300);
    // Declare the resolver BEFORE the listener that captures it, and name the
    // listener so it can be removed in every exit branch (otherwise it leaks on
    // graceController.signal for the life of the controller).
    let resolveGrace: (v: null) => void = () => {};
    const onGraceAbort = () => resolveGrace(null);
    try {
      const result = await Promise.race([
        serverApiCheckPromise,
        new Promise<null>((resolve) => {
          resolveGrace = resolve;
          graceController.signal.addEventListener("abort", onGraceAbort, { once: true });
        }),
      ]);
      clearTimeout(graceTimeout);
      graceController.signal.removeEventListener("abort", onGraceAbort);
      return result;
    } catch {
      clearTimeout(graceTimeout);
      graceController.signal.removeEventListener("abort", onGraceAbort);
      return null;
    }
  }
  return null;
}

// Eagerly kick off the health check the moment this module is imported (i.e. as
// soon as the app loads), so by the time the user actually triggers the first
// transcription the server-availability result is almost always already cached
// and processFile() doesn't have to wait on a /api/health round-trip.
if (typeof window !== "undefined") {
  getServerApiStatusCached();
}

export async function processFile(
  file: File | Blob,
  mimeType: string,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: any) => void,
  preferredModel: string = PRIMARY_GEMINI_MODEL,
  signal?: AbortSignal,
  onChunk?: (text: string) => void,
  contextHint?: string
): Promise<{ text: string; modelUsed: string }> {
  if (!file) {
    throw new Error("File reference or audio binary data is no longer loaded in memory. Please re-upload the audio file to transcribe.");
  }
  const name = (file && typeof file === 'object' && 'name' in file) ? (file as any).name : '';
  let actualMimeType = mimeType || (name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');

  // Override the mime type if it's treated as an audio file.
  if (isAudioFile({ name, type: actualMimeType }) && actualMimeType.startsWith('video/')) {
    actualMimeType = actualMimeType.replace(/^video\//, 'audio/');
  }

  // Clean the MIME type by stripping codecs/parameters (e.g., "audio/webm;codecs=opus" -> "audio/webm")
  // Gemini API strictly rejects MIME types with extra semi-colon parameters.
  if (actualMimeType.includes(';')) {
    actualMimeType = actualMimeType.split(';')[0].trim();
  }

  // --- Content-sniff to correct container/codec mismatches -------------------
  // This is the dominant cause of "Flash is slow" latency for files that were
  // converted/renamed client-side (e.g. a .webm/Opus recording renamed to .mp3
  // carries type="audio/mp3" but the bytes are still Opus). Gemini receives
  // mislabeled bytes, fails to demux, retries through the whole fallback model
  // hierarchy, and that cascade is what surfaces as high latency. By sniffing
  // the magic bytes we send the TRUE container to the API on the first try.
  //
  // sniffAudioContainer() is a pure byte-inspection helper (no decode); it never
  // throws on failure and falls back to the declared MIME, so wrapping it here
  // is belt-and-suspenders and cannot destabilize the call.
  if (isAudioFile({ name, type: actualMimeType })) {
    try {
      const sniff = await sniffAudioContainer(file);
      const sniffedMime = sniff.mime.includes(';')
        ? sniff.mime.split(';')[0].trim()
        : sniff.mime;
      // Only override when the sniff confidently disagrees with the declared
      // type (i.e. it identified a real container). 'application/octet-stream'
      // means the sniff couldn't tell, so keep the declared type in that case.
      if (
        sniff.container &&
        sniff.container !== 'unknown' &&
        sniffedMime &&
        !sniffedMime.startsWith('application/octet-stream') &&
        sniffedMime !== actualMimeType
      ) {
        actualMimeType = sniffedMime;
      }
    } catch (sniffErr) {
      // Sniffing must NEVER block or fail transcription — fall through with the
      // declared MIME on any error.
      console.warn('[Gemini] Audio container sniff failed, using declared MIME:', sniffErr);
    }
  }

  let prompt = `
You are an expert OCR and audio transcription assistant.
Your task is to extract text from the provided image/document or transcribe the provided audio/video verbatim.
The content may be a mixture of Bengali and English.

CRITICAL INSTRUCTION FOR VERBATIM ACCURACY & FILLER WORDS:
You MUST perform an extremely precise, literal, verbatim transcription or text extraction. Do NOT summarize, do NOT correct grammar, do NOT smooth out sentences, and do NOT omit anything.
For audios and videos, you MUST capture every single spoken word, including ALL filler words, stutters, repetitions, and vocalized pauses (such as "um", "uh", "ah", "like", "er", "hmm", "you know", "bujhsen", "ekhane", "mane", etc.) exactly as they are spoken, converting any spoken Bengali filler words into their Banglish sounds.

CRITICAL INSTRUCTION FOR BENGALI & BANGLISH TRANSLITERATION: 
If the content contains Bengali, DO NOT translate it to English. Instead, transcribe the Bengali words into Banglish (Bengali written using the English alphabet/Latin script). 
For example, if the audio says "আমি ভালো আছি", you should output "Ami bhalo achi".
If the content is in English, keep it as English. 
If it is a mix of both, keep the English words as English and write the Bengali words in Banglish.

CRITICAL INSTRUCTION FOR PROPER NOUNS & LOCATIONS:
- You MUST ensure absolute spelling accuracy of proper nouns, famous place names, personal names, landmarks, and locations.
- Under NO circumstance should you write place names or proper nouns as space-separated letters (e.g., do NOT write "D A N L O P" or "D-A-N-L-O-P"). If the speaker says "Dunlop", it must be transcribed as the single, correctly-spelled proper word "Dunlop" (with initial capital letter 'D').
- Pay extremely close attention to the phonetics of regional names (especially Bengali/Indian place names like 'Dakshineswar', 'Dunlop', etc.), and write them with standard, clean proper name forms:
  - Transcribe "Dunlop" as "Dunlop" (NOT "D A N L O P", "Danlop", or "Denlop").
  - Transcribe "Dakshineswar" as "Dakshineswar" (NOT "dakshineshwar" or "Dakhineswar").
- Do not let accents or pronunciations skew proper names.

SPECIFIC BANGLISH WORD GUIDELINES:
- Correct spelling is critical for common connectors, pronouns, and verbs.
- The spoken word "আমি" (I) must be transliterated/spelled as "ami" (NOT "aami").
- The spoken word "আর" (and/else) must be transliterated/spelled as "aar" (NOT "ar"). Ensure words like "aar" are consistently written with "aa".
- The spoken word "দেখ" (see/look) must be transliterated/spelled as "dekh" (NOT "dyakh" or "dakh").
- The spoken word "মধ্যে" (inside/in/between) must be transliterated/spelled as "moddhe" (NOT "modhye").
- The spoken word "হ্যাঁ" (yes) must be transliterated/spelled as "ha" (NOT "haan").
- The spoken word "যায়" (goes) must be transliterated/spelled as "jaye" (NOT "jay").
- The spoken word "সেটা" / "সেটাকে" (it / that) must be transliterated/spelled as "seta" / "setake" (NOT "sheta" / "shetake").
- Words like "সব" (all), "সবai" (everyone), "সবচেয়ে" (most), "সময়" (time), and "সাথে" (with) must be transliterated/spelled with "s" rather than "sh" (e.g. "sob", "sobai", "sobcheye", "somoy", "sathe" - NOT "shob", "shobai", "shobcheye", "shomoy", "shathe").
- However, words like "শিখব" / "শিখছি" (learn), "শুরু" (start), "শেষ" (end) must retain "sh" (e.g., "shikhbo", "shikhchi", "shuru", "shesh").
- The spoken word "আছে" (is / has / there is) and its conjugated forms must be transliterated/spelled with a single "a" rather than "aa" (e.g., "ache" - NOT "aache", "asen" - NOT "aasen", "achis" - NOT "achis", "acho" - NOT "aacho").
- The Bengali phonetic word "তো" (so / then / filler) must ALWAYS be transliterated/spelled as "toh" (NOT "to").
- The native English preposition/infinitive word "to" (e.g., "to do", "go to", "to the") must strictly remain as "to" (do NOT spell it as "toh"). You must distinguish the Bengali "তো" (toh) from the English "to".
- The location "Sinthee More" must be spelled explicitly as "Sinthee More" (NOT "shithir mor", "sithir more", "sinthee mor").
- The Bengali words for "she/he and" or "that and" must be transliterated/spelled as "se aar" (NOT "share", "shear", "se ar", "she aar", "she ar"). Be very careful not to misinterpret "se aar" as the English word "share".

CRITICAL INSTRUCTION FOR PUNCTUATION & SPEECH FLOW:
- Add or include punctuation marks (like full stops, commas, and question marks) naturally reflecting the natural speech flow or overall cadence of the speaker. These should be left as they are and added in accordance with the expression flow.
- However, use LESS exclamation marks (!). Avoid excessive or frequent addition of exclamation marks even if the sentence sounds like an exclamation or is spoken passionately. Use them very sparingly, making sure they are not overused.

CRITICAL INSTRUCTION FOR MATH EQUATIONS:
Using LaTeX formatting:
- Use \`$$\` for block equations and \`$\` for inline equations.

If it's an image or document, extract all visible text following the above rules.
If it's an audio file, transcribe the spoken words exactly as they are (verbatim), following the above rules.
Do not add any conversational filler, just output the extracted text or transcription.
`;

  // When transcribing a live segment in isolation, provide the tail of the
  // already-transcribed text so the model treats this clip as a continuation
  // rather than a standalone utterance. This restores the sentence-level
  // context that full-file transcription has but per-segment lacks, markedly
  // improving live accuracy (otherwise isolated mid-sentence fragments
  // mis-transcribe far more than the complete manual path).
  if (contextHint && contextHint.trim()) {
    prompt += `
CONTINUATION CONTEXT:
This audio is a short segment cut from the middle of a longer recording. The text transcribed so far (immediately before this segment) is:
"${contextHint.trim().slice(-400)}"
Treat this segment as a direct continuation of that text. Do NOT repeat or restate the context above — only output the transcription for THIS segment, flowing naturally from what came before. If this segment picks up mid-word or mid-sentence, transcribe it as such.
`;
  }

  const startTotalProcess = performance.now();
  const apiKey = getApiKey();

  // Try Server-Side Process API First (More secure, avoids browser CORS/CSP issues and supports larger files)
  const startServerCheck = performance.now();
  const serverReachable = await isServerApiAvailable();
  const fitsServerRoute = file.size <= SERVER_ROUTE_MAX_FILE_BYTES;
  const useServer = serverReachable && fitsServerRoute;
  const serverCheckDuration = performance.now() - startServerCheck;
  GeminiPerformanceLogger.log(
    "SERVER_API_CHECK",
    serverCheckDuration,
    `Checked server health. Status: ${serverReachable ? "REACHABLE" : "UNREACHABLE"}${serverReachable && !fitsServerRoute ? " (file too large for server route, using direct client path)" : ""}`,
  );

  if (useServer) {
    const serverProcessStart = performance.now();
    try {
      console.log("[Gemini client-side] Attempting server-side processing via secure API route /api/process-file using stream-form...");
      
      const formData = new FormData();
      formData.append("file", file, name || "file");
      formData.append("mimeType", actualMimeType);
      formData.append("preferredModel", preferredModel);
      formData.append("prompt", prompt);
      formData.append(
        "modelPlan",
        JSON.stringify(buildModelOrder(preferredModel).map((model) => ({ model, thinkingConfig: getThinkingConfig(model) }))),
      );

      const uploadStartTime = performance.now();
      const response = await fetch("/api/process-file", {
        method: "POST",
        headers: {
          "X-Gemini-API-Key": apiKey || "",
        },
        body: formData,
        signal
      });
      const uploadDuration = performance.now() - uploadStartTime;
      GeminiPerformanceLogger.log("SERVER_API_UPLOAD_HANDSHAKE", uploadDuration, "File uploaded and initial server response headers received", preferredModel);

      if (response.ok) {
        // Stream response body chunk-by-chunk for memory health
        const modelUsed = response.headers.get("x-model-used") || preferredModel;

        const reader = response.body?.getReader();
        const decoder = new TextDecoder("utf-8");
        let accumulatedText = "";

        const streamStartTime = performance.now();
        let ttfbRegistered = false;
        let lastUpdateTime = 0;
        const UPDATE_THROTTLE_MS = 250; // Throttle to 4 updates per second to protect CPU and prevent UI freeze

        if (reader) {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              // Honor an in-flight abort between chunks (mirrors the client-side
              // streaming path, which checks signal?.aborted on every iteration).
              if (signal?.aborted) {
                throw new DOMException("The user aborted a request.", "AbortError");
              }
              if (!ttfbRegistered) {
                ttfbRegistered = true;
                const timeToFirstByte = performance.now() - uploadStartTime;
                GeminiPerformanceLogger.log("TIME_TO_FIRST_STREAM_BYTE", timeToFirstByte, "Received first text stream token packet from model", modelUsed);
              }
              const chunk = decoder.decode(value, { stream: true });
              accumulatedText += chunk;
              if (onChunk) {
                const now = performance.now();
                if (now - lastUpdateTime > UPDATE_THROTTLE_MS) {
                  lastUpdateTime = now;
                  onChunk(postProcessBanglish(accumulatedText));
                }
              }
            }
            // Ensure final full processed text is delivered on stream end
            if (onChunk && accumulatedText) {
              onChunk(postProcessBanglish(accumulatedText));
            }
          } finally {
            reader.releaseLock();
          }
        } else {
          accumulatedText = await response.text();
          if (onChunk && accumulatedText) {
            onChunk(postProcessBanglish(accumulatedText));
          }
        }

        const streamEndTime = performance.now();
        const streamingDuration = streamEndTime - streamStartTime;
        const totalDuration = streamEndTime - serverProcessStart;

        GeminiPerformanceLogger.log("SERVER_STREAM_DECODING_COMPLETE", streamingDuration, `Finished streaming and parsing complete text output. Total chars: ${accumulatedText.length}`, modelUsed);
        GeminiPerformanceLogger.log("SERVER_TOTAL_TRANSCRIPTION_FLOW", totalDuration, `Completed full transcription query`, modelUsed);

        // Check if there was a mid-stream server error
        if (accumulatedText.includes("---GEMINI-STREAM-ERROR---:")) {
          const errorPart = accumulatedText.split("---GEMINI-STREAM-ERROR---:")[1] || "Mid-stream transcription error";
          throw new Error(errorPart.trim());
        }

        console.log(`[Gemini client-side] Server-side processing successful using model: ${modelUsed}`);

        return {
          text: postProcessBanglish(accumulatedText),
          modelUsed: modelUsed
        };
      } else {
        const errorText = await response.text();
        console.warn(`[Gemini client-side] Server-side API returned error status ${response.status}: ${errorText}`);
        let serverError: { error?: string; code?: string } = {};
        try {
          serverError = JSON.parse(errorText);
        } catch {}
        // The server already swept every model with cool-downs; repeating the
        // same sweeps from the browser would only double the wait.
        if (serverError.code === "ALL_MODELS_OVERLOADED") {
          const overloadError = new Error(serverError.error || "Gemini is overloaded for every model right now.");
          (overloadError as any).isFinal = true;
          throw overloadError;
        }
        if (serverError.code === "AUTH") {
          const authError = new Error(
            "The API Key provided is either invalid or does not have permission to access the Gemini API. Please check your credentials.",
          );
          (authError as any).isFinal = true;
          throw authError;
        }
        throw new Error(`Server returned ${response.status}: ${serverError.error || errorText}`);
      }
    } catch (serverErr: any) {
      if (signal?.aborted || serverErr.name === "AbortError") {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      if (serverErr?.isFinal) {
        throw serverErr;
      }
      
      const errMsg = String(serverErr?.message || serverErr);
      const isHtmlError = errMsg.includes("<html>") || errMsg.includes("<head>");
      
      // If the server proxy blocks us with HTML (like 413 or 403 from WAF), we should fall back to direct client-side
      if (isHtmlError) {
        console.log("[Gemini client-side] Server-side route returned HTML. Falling back to direct client-side GoogleGenAI SDK...", errMsg.substring(0, 50));
      } else {
        const lowerErrMsg = errMsg.toLowerCase();
        const isAuthError = lowerErrMsg.includes("invalid api key") || 
                           lowerErrMsg.includes("permission_denied") || 
                           lowerErrMsg.includes("ya29") || 
                           lowerErrMsg.includes("key not valid") || 
                           lowerErrMsg.includes("api_key_invalid");
                           
        if (isAuthError) {
          let cleanMessage = "The API Key provided is either invalid or does not have permission to access the Gemini API. Please check your credentials.";
          
          try {
            let jsonPart = errMsg.substring(errMsg.indexOf('{'));
            if (jsonPart) {
              const parsed = JSON.parse(jsonPart);
              if (parsed.details) {
                  if (parsed.details.includes("PERMISSION_DENIED")) {
                      cleanMessage = "Your Gemini API Key does not have access to the requested model. Ensure billing is enabled and API is enabled in Google Cloud Console.";
                  }
              } else if (parsed.error && parsed.error.message) {
                  cleanMessage = parsed.error.message;
              }
            }
          } catch(e) {}
          
          throw new Error(cleanMessage);
        }
        
        console.log("[Gemini client-side] Server-side route failed. Falling back to direct client-side GoogleGenAI SDK... Details:", serverErr.message);
      }
    }
  } else {
    console.log("[Gemini client-side] Server API unreachable. Skipping server-side processing to eliminate upload delay.");
  }

  // Fallback direct base64 loader
  let base64Data: string | null = null;
  const loadBase64 = async () => {
    if (base64Data) return base64Data;
    const base64Start = performance.now();

    // Chunked, NON-BLOCKING Base64 encoder.
    //
    // The previous implementation used FileReader.readAsDataURL(), which builds a
    // single contiguous `data:<mime>;base64,<...>` string for the ENTIRE file and
    // then split() it — for a multi-MB audio file that is one giant synchronous
    // allocation on the main thread that freezes the UI and ~doubles peak memory
    // (data-URL string + the extracted base64 string both live at once).
    //
    // This version:
    //   - reads the raw ArrayBuffer once (browser streams it, no double buffer),
    //   - encodes base64 in fixed byte-chunks,
    //   - yields to the event loop between chunks so the transcription progress /
    //     UI never blocks (keeps the "Flash feels fast" perception intact),
    //   - avoids the data-URL wrapper entirely, so only the final base64 string
    //     is retained (less payload overhead / memory pressure).
    base64Data = await new Promise<string>((resolve, reject) => {
      (file.arrayBuffer ? file.arrayBuffer() : file.slice().arrayBuffer())
        .then((arrayBuffer: ArrayBuffer) => {
          try {
            const bytes = new Uint8Array(arrayBuffer);
            const CHUNK_BYTES = 3 * 32768; // multiple of 3 → no padding mid-stream
            const outputChunks: string[] = [];

            const processChunk = (offset: number) => {
              // If the caller aborted while we were yielding, stop encoding.
              if (signal?.aborted) {
                reject(new DOMException("The user aborted a request.", "AbortError"));
                return;
              }
              const end = Math.min(offset + CHUNK_BYTES, bytes.length);
              if (offset >= end) {
                // Join once at the end. Array.join on a known-length list is a
                // single allocation, far cheaper than repeated string concat.
                resolve(outputChunks.join(''));
                return;
              }
              outputChunks.push(base64EncodeChunk(bytes, offset, end));
              // Yield to the event loop after EVERY chunk so UI updates / streaming
              // remain smooth and the main thread is never held across the whole
              // encode. setTimeout(0) is the cheapest cross-browser cooperative yield.
              setTimeout(() => processChunk(end), 0);
            };
            processChunk(0);
          } catch (err) {
            reject(err);
          }
        })
        .catch(reject);
    });

    const base64Duration = performance.now() - base64Start;
    GeminiPerformanceLogger.log("CLIENT_BASE64_LOAD_LATENCY", base64Duration, "Chunked non-blocking Base64 encode of file bytes");
    
    // Track the raw base64 string in MemoryTracker
    try {
      MemoryTracker.register(
        base64Data, 
        `Base64 Binary Content (${name || 'Processing File'})`, 
        "String (Base64)", 
        base64Data.length * 2
      );
    } catch (err) {}
    return base64Data;
  };

  try {
    // Fallback to direct client-side execution (e.g. when downloaded and deployed to Netlify as static SPA)
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY is not configured in the application environment. Please configure it in your hosting provider's environment settings or local .env file."
      );
    }

    // Automatically determine standard API key vs OAuth token
    const clientConfigStart = performance.now();
    const isOAuthToken = apiKey.startsWith("ya29.");
    const clientConfig: any = {};
    if (isOAuthToken) {
      clientConfig.authToken = apiKey;
    } else {
      clientConfig.apiKey = apiKey;
    }
    const ai = new GoogleGenAI(clientConfig);
    const clientConfigDuration = performance.now() - clientConfigStart;
    GeminiPerformanceLogger.log("CLIENT_SDK_INITIALIZATION_HANDSHAKE", clientConfigDuration, "Direct GoogleGenAI instance initialized successfully for fallback mode");

    // Always start from the requested model (default: the top of the hierarchy)
    // and walk the rest in order. A cached "last success" model is deliberately
    // NOT used here — it made runs silently skip gemini-3.5-flash-lite.
    const modelsToTry = buildModelOrder(preferredModel);

    let successResult: { text: string; modelUsed: string } | null = null;
    const errors: any[] = [];

    // When Google returns 503 "high demand" for EVERY model, retrying within a
    // few seconds just gets another 503. Sweep the whole hierarchy quickly, then
    // back off with growing cool-downs between sweeps (~2 minutes in total).
    const SWEEP_COOLDOWNS_MS = [10000, 20000, 40000, 60000];
    const MAX_PASSES = SWEEP_COOLDOWNS_MS.length + 1;
    for (let pass = 1; pass <= MAX_PASSES && !successResult; pass++) {
    if (pass > 1) {
      if (!errors.every(e => isTransientError(e.error))) break;
      const cooldownMs = SWEEP_COOLDOWNS_MS[pass - 2];
      console.log(`[Gemini client-side] All models busy, cooling down ${cooldownMs / 1000}s before sweep ${pass}/${MAX_PASSES}...`);
      onRetry?.(
        pass - 1,
        MAX_PASSES - 1,
        cooldownMs,
        new Error(`All Gemini models are busy right now (Google high demand). Retrying in ${cooldownMs / 1000}s (sweep ${pass}/${MAX_PASSES})...`),
      );
      errors.length = 0;
      await waitWithAbort(cooldownMs, signal);
    }
    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    // Busy models are raced (see geminiRace.ts): if the current model hasn't
    // started streaming after a few seconds, the next one starts in parallel
    // and whichever answers first wins. Previously each busy model could hang
    // for 10-50s before returning 503, one after another.
    const b64 = await loadBase64();
    const contents = {
      parts: [
        { inlineData: { data: b64, mimeType: actualMimeType || "application/octet-stream" } },
        {
          text: actualMimeType.startsWith("image/")
            ? "Extract text verbatim."
            : "Classify and transcribe verbatim, following system-defined transliteration/transcription rules.",
        },
      ],
    };
    const sdkInvokeStart = performance.now();
    const { winner, errors: raceErrors } = await raceToFirstChunk<any>({
      plan: modelsToTry.map((model) => ({ model, thinkingConfig: getThinkingConfig(model) })),
      signal,
      ...raceTimingsFor(file.size),
      maxParallel: 2,
      isFatal: isClientAuthError,
      isInvalidArgument: isInvalidArgumentError,
      log: (message) => console.log(`[Gemini client-side] ${message}`),
      start: (entry, useThinking, attemptSignal) =>
        ai.models.generateContentStream({
          model: entry.model,
          contents,
          config: {
            systemInstruction: prompt,
            temperature: 0.0,
            abortSignal: attemptSignal,
            ...(useThinking && entry.thinkingConfig ? { thinkingConfig: entry.thinkingConfig as any } : {}),
          },
        }),
    });

    if (signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }

    const fatal = raceErrors.find((e) => isClientAuthError(e.error));
    if (fatal) {
      const fatalMsg = String(fatal.error?.message || fatal.error).toLowerCase();
      throw new Error(
        fatalMsg.includes("permission_denied")
          ? "Your Gemini API Key does not have access to the requested model. Ensure billing is enabled and API is enabled in Google Cloud Console."
          : "The API Key provided is either invalid or does not have permission to access the Gemini API. Please check your credentials.",
      );
    }
    errors.push(...raceErrors);

    if (winner) {
      const currentModel = winner.model;
      GeminiPerformanceLogger.log("CLIENT_TIME_TO_FIRST_STREAM_BYTE", performance.now() - sdkInvokeStart, "First stream chunk received (after model race)", currentModel);
      try {
        let accumulatedText = "";
        let lastUpdateTime = 0;
        const UPDATE_THROTTLE_MS = 250; // Throttle to 4 updates per second to protect CPU and prevent UI freeze

        let step = winner.first;
        while (!step.done) {
          if (signal?.aborted) {
            throw new DOMException("The user aborted a request.", "AbortError");
          }
          const chunkText = step.value?.text;
          if (chunkText) {
            accumulatedText += chunkText;
            if (onChunk) {
              const now = performance.now();
              if (now - lastUpdateTime > UPDATE_THROTTLE_MS) {
                lastUpdateTime = now;
                onChunk(postProcessBanglish(accumulatedText));
              }
            }
          }
          step = await winner.iterator.next();
        }
        if (onChunk && accumulatedText) {
          onChunk(postProcessBanglish(accumulatedText));
        }

        GeminiPerformanceLogger.log("CLIENT_SDK_GENERATE_CONTENT_LATENCY", performance.now() - sdkInvokeStart, "Direct stream API request finalized", currentModel);

        if (!accumulatedText) {
          throw new Error(`Empty response text from model ${currentModel}`);
        }
        GeminiPerformanceLogger.log("CLIENT_TOTAL_FALLBACK_FLOW", performance.now() - startTotalProcess, "Succeeded using fallback route", currentModel);
        successResult = { text: postProcessBanglish(accumulatedText), modelUsed: currentModel };
      } catch (err: any) {
        if (signal?.aborted || err?.name === "AbortError") {
          throw new DOMException("The user aborted a request.", "AbortError");
        }
        console.warn(`[Gemini client-side] Stream from ${currentModel} failed mid-way:`, err);
        errors.push({ model: currentModel, error: err });
      }
    }
    }

    if (successResult) {
      return successResult;
    }

    if (errors.length > 0 && errors.every(e => isTransientError(e.error))) {
      throw new Error(
        "Google's Gemini servers are overloaded for every model right now (503 high demand). Your file and API key are fine — please try again in a few minutes.",
      );
    }
    const combined = errors.map(e => `${e.model}: ${e.error.message || e.error}`).join(" | ");
    throw new Error(`All client-side Gemini model fallbacks failed: ${combined}`);
  } finally {
    base64Data = null;
    console.log(`[Gemini client-side] Successfully garbage-collected Base64 buffers for ${name}`);
  }
}

function postProcessBanglish(text: string): string {
  if (!text) return text;
  
  let processed = text;
  
  // A. Correct Dunlop spelled out as discrete letters (e.g., D A N L O P or D-A-N-L-O-P with spaces/hyphens)
  processed = processed.replace(/\b[dD][-\s]+[aAeE][-\s]+[nN][-\s]+[lL][-\s]+[oO][-\s]+[pP]\b/gi, "Dunlop");
  
  // B. Correct misspellings/variations of Dunlop
  processed = processed.replace(/\b(d|D)anlop\b/g, "Dunlop");
  processed = processed.replace(/\b(d|D)enlop\b/g, "Dunlop");

  // C. Correct Dakshineswar spelled out or having other variations
  processed = processed.replace(/\b[dD][-\s]+[aA][-\s]+[kK][-\s]+[sS][-\s]+[hH][-\s]+[iI][-\s]+[nN][-\s]+[eE][-\s]+[sS][-\s]+[wW][-\s]+[aA][-\s]+[rR]\b/gi, "Dakshineswar");
  processed = processed.replace(/\b(d|D)akshinesh?war\b/g, "Dakshineswar");
  processed = processed.replace(/\b(d|D)akshinesh?wari\b/g, "Dakshineswari");
  processed = processed.replace(/\b(d|D)akhineswar\b/g, "Dakshineswar");
  
  // 1. modhye -> moddhe
  processed = processed.replace(/\b(m|M)odhye\b/g, (_, p1) => {
    return p1 === 'M' ? 'Moddhe' : 'moddhe';
  });

  // 2. haan -> ha
  processed = processed.replace(/\b(h|H)aan\b/g, (_, p1) => {
    return p1 === 'H' ? 'Ha' : 'ha';
  });

  // 3. jay -> gaye / jaye
  processed = processed.replace(/\b(j|J)ay\b/g, (_, p1) => {
    return p1 === 'J' ? 'Jaye' : 'jaye';
  });

  // 4. aami -> ami
  processed = processed.replace(/\b(a|A)ami\b/g, (_, p1) => {
    return p1 === 'A' ? 'Ami' : 'ami';
  });

  // 5. dyakh -> dekh, dakh -> dekh
  processed = processed.replace(/\b(d|D)yakh\b/g, (_, p1) => {
    return p1 === 'D' ? 'Dekh' : 'dekh';
  });
  processed = processed.replace(/\b(d|D)akh\b/g, (_, p1) => {
    return p1 === 'D' ? 'Dekh' : 'dekh';
  });

  // 6. ar -> aar
  processed = processed.replace(/\b(a|A)r\b/g, (_, p1) => {
    return p1 === 'A' ? 'Aar' : 'aar';
  });

  // 7. sheta -> seta (including shetake, shetar, shetat, etc.)
  processed = processed.replace(/\b(s|S)heta(\w*)\b/g, (_, p1, p2) => {
    return (p1 === 'S' ? 'Seta' : 'seta') + p2;
  });

  // 8. shob -> sob (including shobai, shobcheye, etc.)
  processed = processed.replace(/\b(s|S)hob(\w*)\b/g, (_, p1, p2) => {
    return (p1 === 'S' ? 'Sob' : 'sob') + p2;
  });

  // 9. shomoy -> somoy (including shomoye, etc.)
  processed = processed.replace(/\b(s|S)homoy(\w*)\b/g, (_, p1, p2) => {
    return (p1 === 'S' ? 'Somoy' : 'somoy') + p2;
  });

  // 10. shathe -> sathe (including shathei, etc.)
  processed = processed.replace(/\b(s|S)hathe(\w*)\b/g, (_, p1, p2) => {
    return (p1 === 'S' ? 'Sathe' : 'sathe') + p2;
  });

  // 11. aach... -> ach... (e.g. aache -> ache, aachis -> achis, aachen -> achen, aacho -> acho)
  processed = processed.replace(/\b(a|A)ach(\w*)\b/g, (_, p1, p2) => {
    return (p1 === 'A' ? 'Ach' : 'ach') + p2;
  });

  // 12. shithir mor -> sinthee more (captures variations like shithir mor, sithir more, sinthee mor, shintee more, etc.)
  processed = processed.replace(/\b([sS])h?i[nt]*h?(?:i|ee)[rs]?\s+mo[r]e?\b/gi, (_, p1) => {
    return p1 === 'S' ? 'Sinthee More' : 'sinthee more';
  });

  // 13. shear/share -> se aar (captures variations like share, shear, se ar, she aar, she ar)
  processed = processed.replace(/\b([sS])h?(?:ear|are|e\s+a{1,2}r)\b/gi, (_, p1) => {
    return p1 === 'S' ? 'Se aar' : 'se aar';
  });

  return processed;
}

// ---------------------------------------------------------------------------
// SILENCE-HALLUCINATION FILTER
// ---------------------------------------------------------------------------
// When a speech-to-text model is fed silent / ambient audio, it tends to
// "hallucinate" stock phrases it has seen frequently in training (YouTube
// outro boilerplate, captioning artifacts, etc.). These never reflect what the
// user said and must never render in the live transcript. This client-side
// post-filter strips them AFTER a segment is transcribed (the VAD pre-gate in
// AudioRecorder drops the obviously-silent segments first; this catches the
// ghosts that slip past on near-silent audio).
//
// Two tiers:
//   - HALLUCINATION_PHRASES: specific YouTube/captioning boilerplate that is
//     essentially never part of real dictation. Safe to strip even when it
//     appears as a trailing fragment ("...and that's it. Thank you for
//     watching").
//   - HALLUCINATION_WHOLE_ONLY: short fragments ("thank you", "you", "uh",
//     "the end", the Bengali system-prompt leakage "ami bhalo achi"/"se aar")
//     that ARE legitimate mid-speech, so they are only dropped when they make
//     up the ENTIRE segment (the signature of a silent-clip hallucination).

export const HALLUCINATION_PHRASES: string[] = [
  "thank you for watching",
  "thanks for watching",
  "thank you for listening",
  "thanks for listening",
  "please subscribe",
  "please like and subscribe",
  "like and subscribe",
  "subscribe for more",
  "don't forget to subscribe",
  "do not forget to subscribe",
  "thanks for your support",
  "thank you for your support",
  "see you next time",
  "see you in the next video",
  "see you in the next episode",
  "i hope you enjoyed",
  "hope you enjoyed",
  "enjoyed this video",
  "please leave a comment",
  "let me know in the comments",
  "if you enjoyed this video",
  "subtitles by",
  "subtitle",
  "amara",
];

// Fragments dropped ONLY when they are the entire (normalized) segment.
const HALLUCINATION_WHOLE_ONLY: string[] = [
  "thank you",
  "thanks",
  "bye",
  "goodbye",
  "music",
  "you",
  "uh",
  "um",
  "the end",
  // Bengali/Banglish system-prompt leakage emitted on silence (legitimate
  // mid-speech, so only drop when the whole segment is just this):
  "ami bhalo achi",
  "se aar",
];

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // strip [music]/[applause]/[laughter] bracket tags
    .replace(/[^\p{L}\p{N}\s']/gu, " ") // keep letters/numbers/spaces/apostrophes
    .replace(/\s+/g, " ")
    .trim();
}

// Pre-normalize the phrase lists once at module load (avoids re-allocating the
// comparison set on every transcribed segment).
const _normalizedAll = [...HALLUCINATION_PHRASES, ...HALLUCINATION_WHOLE_ONLY].map((p) =>
  normalizeForCompare(p),
);

/**
 * Strip silence-hallucination phrases from a transcribed segment.
 *
 * Returns:
 *   - { filtered: "",           isHallucination: true  } → whole segment was a ghost; caller should DROP it.
 *   - { filtered: "<stripped>", isHallucination: false } → a trailing ghost fragment was removed; keep the rest.
 */
export function filterHallucinationPhrases(
  text: string,
): { filtered: string; isHallucination: boolean } {
  if (!text || !text.trim()) {
    return { filtered: "", isHallucination: true };
  }

  const normalized = normalizeForCompare(text);
  if (!normalized) {
    // Pure punctuation / bracket noise with no real words → ghost.
    return { filtered: "", isHallucination: true };
  }

  // 1. WHOLE-SEGMENT GHOST: the entire normalized segment is exactly one of the
  //    known fragments (either tier). Drop the segment entirely.
  if (_normalizedAll.includes(normalized)) {
    return { filtered: "", isHallucination: true };
  }

  // 2. TRAILING-FRAGMENT GHOST: strip a YouTube-boilerplate phrase (HALLUCINATION_PHRASES
  //    only — NOT the whole-only fragments, which are legitimate mid/tail speech)
  //    if it appears at the very end of the segment, along with any trailing
  //    punctuation/whitespace around it.
  let working = text;
  for (const phrase of HALLUCINATION_PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    working = working.replace(
      new RegExp(`[\\s\\p{P}]*${escaped}[\\s\\p{P}]*$`, "iu"),
      "",
    );
  }
  // Tidy: collapse runs of whitespace and drop any leading punctuation left
  // behind by the strip.
  working = working.replace(/\s{2,}/g, " ").replace(/^[\s.,;:!?\-]+/, "").trim();

  // 3. If nothing meaningful remains after stripping → whole-segment ghost.
  if (!normalizeForCompare(working)) {
    return { filtered: "", isHallucination: true };
  }

  return { filtered: working, isHallucination: false };
}
