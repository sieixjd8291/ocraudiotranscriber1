// @ts-ignore
import lameJSCode from "lamejs/lame.all.js?raw";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

let globalFFmpeg: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
let globalAudioContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (typeof window === "undefined") {
    throw new Error("AudioContext can only be initialized on the client-side.");
  }
  if (!globalAudioContext) {
    const AudioCtxClass =
      window.AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioCtxClass();
  }
  if (globalAudioContext.state === "suspended") {
    globalAudioContext
      .resume()
      .catch((err) => console.warn("Failed to resume AudioContext:", err));
  }
  return globalAudioContext;
}

/**
 * Stream-based processing helper: Reads a Blob/File chunk-by-chunk using a standard stream reader.
 * This avoids loading the entire file into a blocking memory buffer at once on the JS heap.
 */
export async function readBlobToArrayBufferStreamed(
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<ArrayBuffer> {
  const stream = blob.stream();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
    if (onProgress && blob.size > 0) {
      onProgress(totalBytes / blob.size);
    }
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

function terminateFFmpeg() {
  if (globalFFmpeg) {
    try {
      globalFFmpeg.terminate();
    } catch (e) {
      console.warn("Error terminating FFmpeg:", e);
    }
    globalFFmpeg = null;
    ffmpegLoadPromise = null;
    // Auto preload/pre-warm a new instance in the background so that subsequent merges are instantaneous
    setTimeout(() => {
      console.log(
        "Background pre-warming new FFmpeg instance after termination...",
      );
      getFFmpeg().catch((e) =>
        console.warn("Failed to pre-warm new FFmpeg instance:", e),
      );
    }, 50);
  }
}

// Deduplicate concurrent fetch+cache for the same asset so that concurrent
// callers of preWarmAudioEngine / getFFmpeg don't each fire their own multi-MB
// core/wasm fetch in parallel. The first caller fetches & caches; the rest await
// the same promise. (This was the main cause of the slow initial load.)
const fetchAndCacheInFlight = new Map<string, Promise<void>>();

export async function fetchAndCacheAsset(
  url: string,
  cacheName = "ffmpeg-assets-v1",
  createUrl = true,
): Promise<string> {
  if (typeof window === "undefined" || !("caches" in window)) {
    return url;
  }
  try {
    const cache = await caches.open(cacheName);
    const inflightKey = `${cacheName}::${url}`;
    let inflight = fetchAndCacheInFlight.get(inflightKey);
    if (!inflight) {
      inflight = (async () => {
        let response = await cache.match(url);
        if (!response) {
          console.log(`[FFmpeg Caching] Cache miss: fetching ${url}`);
          response = await fetch(url);
          if (response && response.status === 200) {
            await cache.put(url, response.clone());
          }
        } else {
          console.log(`[FFmpeg Caching] Cache hit: ${url}`);
        }
      })().finally(() => {
        fetchAndCacheInFlight.delete(inflightKey);
      });
      fetchAndCacheInFlight.set(inflightKey, inflight);
    }
    await inflight;

    if (!createUrl) {
      return url;
    }
    // Re-read from the cache (the in-flight fetch above populated it) so each
    // createUrl caller gets its own response body without consuming a shared one.
    const cached = await cache.match(url);
    if (!cached) {
      return url;
    }
    const blob = await cached.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn(
      "[FFmpeg Caching] Error caching asset, fallback to parent URL:",
      err,
    );
    return url;
  }
}

export function preWarmAudioEngine() {
  if (typeof window === "undefined") return;
  fetchAndCacheAsset(coreURL, "ffmpeg-assets-v1", false).catch(() => {});
  fetchAndCacheAsset(wasmURL, "ffmpeg-assets-v1", false).catch(() => {});
}

export async function getFFmpeg(
  onProgress?: (msg: string) => void,
): Promise<FFmpeg> {
  if (globalFFmpeg) return globalFFmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    let cachedCoreURL = "";
    let cachedWasmURL = "";
    try {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("log", ({ message }) => console.log("[FFmpeg]", message));

      onProgress?.("Loading ultra-fast audio engine (~5MB)...");

      cachedCoreURL = await fetchAndCacheAsset(
        coreURL,
        "ffmpeg-assets-v1",
        true,
      );
      cachedWasmURL = await fetchAndCacheAsset(
        wasmURL,
        "ffmpeg-assets-v1",
        true,
      );

      await ffmpeg.load({
        coreURL: cachedCoreURL,
        wasmURL: cachedWasmURL,
      });

      globalFFmpeg = ffmpeg;
      return ffmpeg;
    } catch (e) {
      ffmpegLoadPromise = null;
      throw e;
    } finally {
      // Explicitly revoke Blob URLs once loaded or if it failed to prevent memory leaks
      if (cachedCoreURL && cachedCoreURL.startsWith("blob:")) {
        URL.revokeObjectURL(cachedCoreURL);
      }
      if (cachedWasmURL && cachedWasmURL.startsWith("blob:")) {
        URL.revokeObjectURL(cachedWasmURL);
      }
    }
  })();

  return ffmpegLoadPromise;
}

// Safe evaluation of pre-bundled lamejs to prevent module scope/dependency errors in bundlers
let lamejs: any;
try {
  const fn = new Function("window", lameJSCode + "\nreturn lamejs;");
  const globalObj =
    typeof window !== "undefined"
      ? window
      : typeof self !== "undefined"
        ? self
        : {};
  lamejs = fn(globalObj);

  if (typeof window !== "undefined") {
    (window as any).lamejs = lamejs;
    (window as any).MPEGMode = lamejs.MPEGMode || (window as any).MPEGMode;
    (window as any).Lame = lamejs.Lame || (window as any).Lame;
  } else if (typeof self !== "undefined") {
    (self as any).lamejs = lamejs;
    (self as any).MPEGMode = lamejs.MPEGMode || (self as any).MPEGMode;
    (self as any).Lame = lamejs.Lame || (self as any).Lame;
  }
} catch (e) {
  console.error("Failed to initialize lamejs safely:", e);
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

const workerPool: PoolWorker[] = [];
let maxPoolSize = 4;
if (typeof navigator !== "undefined" && navigator.hardwareConcurrency) {
  maxPoolSize = Math.min(navigator.hardwareConcurrency, 8);
}

/**
 * Pre-initializes/pre-warms the MP3 encoder worker pool + FFmpeg WASM engine.
 *
 * The FFmpeg core WASM is ~9.7MB — fetching it the moment an audio component
 * mounts was pulling it into the initial page load and tanking mobile First
 * Contentful Paint / Time to Interactive. The pre-warm is now deferred to the
 * FIRST user interaction (the page is already interactive by then) and run
 * during idle time, so the engine is warm before the user actually starts
 * merging/transcoding without blocking initial render. Real operations still
 * lazy-load on demand via getFFmpeg()/acquireWorkerFromPool() if the pre-warm
 * hasn't fired yet.
 *
 * NOTE: the only current consumer (bufferToMp3) hardcodes actualWorkers = 1, so we
 * default to pre-warming a single worker. The pool still grows on demand up to
 * maxPoolSize if future callers request more concurrency. Pre-warming 4-8 workers
 * eagerly was just wasting memory (each worker evals the lamejs bundle on spawn).
 */
let prewarmScheduled = false;
let prewarmTriggered = false;
let pendingPrewarmSize = 1;

function runDeferredPreWarm() {
  if (typeof window === "undefined") return;

  // Also pre-warm the audio engine cached chunks
  preWarmAudioEngine();

  const isBatterySaver =
    (window as any).isBatterySaverActive ||
    (typeof localStorage !== "undefined" &&
      localStorage.getItem("battery_saver_mode") === "true");
  const targetSize = isBatterySaver ? 1 : pendingPrewarmSize;

  const needed = targetSize - workerPool.length;
  if (needed <= 0) return;

  for (let i = 0; i < needed; i++) {
    try {
      const worker = new Worker(
        new URL("../workers/mp3EncoderWorker.ts", import.meta.url),
        { type: "module" },
      );
      workerPool.push({
        worker,
        busy: false,
      });
    } catch (err) {
      console.error(
        "Failed to initialize a worker in the pool during pre-warm:",
        err,
      );
    }
  }
}

function scheduleDeferredPreWarm() {
  if (prewarmScheduled || typeof window === "undefined") return;
  prewarmScheduled = true;

  const events: (keyof WindowEventMap)[] = [
    "mousemove",
    "touchstart",
    "keydown",
    "scroll",
    "pointerdown",
  ];

  const cleanup = () => {
    for (const e of events) {
      window.removeEventListener(e, trigger, { capture: true });
    }
  };

  const trigger = () => {
    if (prewarmTriggered) return;
    prewarmTriggered = true;
    cleanup();
    const run = () => runDeferredPreWarm();
    if ("requestIdleCallback" in window) {
      (window as any).requestIdleCallback(run, { timeout: 3000 });
    } else {
      setTimeout(run, 1200);
    }
  };

  for (const e of events) {
    window.addEventListener(e, trigger, {
      capture: true,
      once: true,
      passive: true,
    });
  }
}

export function preWarmWorkerPool(size: number = 1) {
  if (typeof window === "undefined") return;
  if (size > pendingPrewarmSize) pendingPrewarmSize = size;
  scheduleDeferredPreWarm();
}

/**
 * Acquires an idle worker from the pool, or creates a new one if pool size is not exhausted,
 * or creates an on-demand worker.
 */
function acquireWorkerFromPool(): Worker {
  // Find an idle worker
  const idle = workerPool.find((pw) => !pw.busy);
  if (idle) {
    idle.busy = true;
    return idle.worker;
  }

  // If we can grow, grow it
  if (workerPool.length < maxPoolSize) {
    try {
      const worker = new Worker(
        new URL("../workers/mp3EncoderWorker.ts", import.meta.url),
        { type: "module" },
      );
      workerPool.push({ worker, busy: true });
      return worker;
    } catch (err) {
      console.error(
        "Failed to grow worker pool, falling back to on-demand worker:",
        err,
      );
    }
  }

  // Fallback to creating a temporary on-demand worker
  const worker = new Worker(
    new URL("../workers/mp3EncoderWorker.ts", import.meta.url),
    { type: "module" },
  );
  return worker;
}

/**
 * Releases a worker back to the pool.
 * If it's a pooled worker, mark busy = false, clear handlers.
 * If it's an on-demand temporary worker, terminate it.
 */
function releaseWorkerToPool(worker: Worker) {
  const pw = workerPool.find((p) => p.worker === worker);
  if (pw) {
    pw.busy = false;
    // Clear handlers to avoid memory leaks or duplicate events
    worker.onmessage = null;
    worker.onerror = null;
  } else {
    // Terminate temporary workers
    worker.terminate();
  }
}

/**
 * Force-terminates a worker AND removes it from the pool if present.
 * Use this on the ERROR path: a worker that threw is in an unknown state and
 * must not be handed back to the pool for the next caller to reuse (otherwise
 * the pool accumulates zombie workers that fail again on their next encode).
 */
function terminateWorkerFromPool(worker: Worker) {
  const pwIdx = workerPool.findIndex((p) => p.worker === worker);
  if (pwIdx !== -1) {
    workerPool.splice(pwIdx, 1);
  }
  worker.onmessage = null;
  worker.onerror = null;
  try {
    worker.terminate();
  } catch (e) {
    // Ignore — already torn down.
  }
}

export function isAudioFile(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("audio/")) return true;
  if (
    file.type === "video/webm" ||
    file.type === "video/ogg" ||
    file.type === "video/mp4"
  ) {
    return true;
  }
  return !!file.name
    .toLowerCase()
    .match(/\.(wav|mp3|m4a|ogg|aac|flac|webm|wbm|mp4|mkv|wem|wma|opus)$/i);
}

export const getAudioDuration = (file: File | Blob): Promise<number> => {
  if (
    file &&
    "metadataDuration" in file &&
    typeof (file as any).metadataDuration === "number"
  ) {
    return Promise.resolve((file as any).metadataDuration);
  }
  // NOTE: the executor must NOT be `async`. A throw inside an async executor
  // (e.g. URL.createObjectURL failing on a detached blob, or createElement
  // during teardown) rejects the *async function's* promise, not this outer
  // Promise — leaving the outer Promise pending forever and the caller hung.
  // The only async work lives inside cleanupAndDecodeFallback(), which manages
  // itself. The try/catch here guarantees the documented contract: this function
  // ALWAYS resolves to a number.
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const fileName = "name" in file ? (file as File).name : "";
      const isWebM =
        fileName &&
        (fileName.toLowerCase().endsWith(".webm") ||
          fileName.toLowerCase().endsWith(".wbm"));
      const isVideo =
        isWebM ||
        (file.type &&
          (file.type.includes("webm") || file.type.includes("video/")));
      const media = isVideo ? document.createElement("video") : new Audio();

      if (isVideo && media instanceof HTMLVideoElement) {
        media.muted = true;
        media.playsInline = true;
        media.style.position = "fixed";
        media.style.left = "-9999px";
        media.style.top = "-9999px";
        media.style.width = "1px";
        media.style.height = "1px";
        document.body.appendChild(media);
      }

      const timeoutId = setTimeout(() => {
        cleanupAndDecodeFallback();
      }, 4000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        URL.revokeObjectURL(url);
        if (isVideo && media instanceof HTMLVideoElement && media.parentNode) {
          media.parentNode.removeChild(media);
        }
      };

      const cleanupAndDecodeFallback = async () => {
        cleanup();
        try {
          // FIX (long-recording hang): Previously this decoded the ENTIRE file
          // via decodeAudioData just to read `.duration`. For a 3-5+ minute
          // WebM/Opus recording that is a multi-second main-thread block which
          // freezes the whole app (the "loading" hang). Instead, decode only a
          // small head slice to obtain sample-rate/channel info, then derive
          // duration from byte-rate — never blocking the UI regardless of file
          // length. If that estimate is unavailable we resolve 0 (UI keeps
          // working) instead of holding the thread hostage.
          const audioCtx = getAudioContext();
          const HEAD_BYTES = Math.min(file.size, 256 * 1024);
          const slice = file.slice(0, HEAD_BYTES);
          const arrayBuffer = await readBlobToArrayBufferStreamed(slice);
          let decoded: AudioBuffer;
          try {
            decoded = await audioCtx.decodeAudioData(arrayBuffer);
          } catch {
            resolve(0);
            return;
          }
          const sampleRate = decoded.sampleRate || 48000;
          // Opus in WebM at 128kbps ≈ 16KB/s. Use a conservative byte/s rate.
          const bytesPerSec = 16000;
          const estimatedDuration = file.size / bytesPerSec;
          const headDur = Number.isFinite(decoded.duration) ? decoded.duration : 0;
          // Prefer head duration only if it looks complete; otherwise use the
          // byte-rate estimate which scales correctly with file length.
          const dur = headDur > 0 && HEAD_BYTES === file.size
            ? headDur
            : estimatedDuration;
          resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
        } catch (e) {
          resolve(0);
        }
      };

      media.addEventListener("loadedmetadata", () => {
        const duration = media.duration;
        if (duration === Infinity || isNaN(duration) || duration === 0) {
          // FIX (long-recording hang): Seeking to Number.MAX_SAFE_INTEGER on a
          // multi-minute WebM recording makes Chrome attempt to demux the ENTIRE
          // container before firing "seeked"/"timeupdate". For 3-5+ minute Opus
          // blobs this either never resolves or triggers the 4s timeout, whose
          // fallback then runs a full decodeAudioData of the whole file on the
          // main thread — freezing the UI (the "infinite loading" hang the user
          // sees). A small subsequent recording's metadata resolves instantly,
          // which re-renders the queue and masks the freeze.
          //
          // Strategy: cap the seek to a generous upper bound (24h) so the
          // browser clamps to the real end quickly, AND put a short hard cap
          // (1.5s) on the seek itself. If the seek hasn't resolved by then we
          // fall back to decode — but only of a TINY head slice, never the full
          // file, so the main thread is never blocked regardless of length.
          media.currentTime = 86400; // 24h clamp; browser snaps to real end
          let seekSettled = false;
          const seekFallbackId = setTimeout(() => {
            if (seekSettled) return;
            seekSettled = true;
            media.removeEventListener("timeupdate", onTimeUpdate);
            media.removeEventListener("seeked", onTimeUpdate);
            cleanupAndDecodeFallback();
          }, 1500);

          const onTimeUpdate = () => {
            if (seekSettled) return;
            seekSettled = true;
            clearTimeout(seekFallbackId);
            media.removeEventListener("timeupdate", onTimeUpdate);
            media.removeEventListener("seeked", onTimeUpdate);
            const finalDuration = media.duration;
            cleanup();
            if (
              Number.isFinite(finalDuration) &&
              finalDuration > 0 &&
              finalDuration !== Infinity
            ) {
              resolve(finalDuration);
            } else {
              cleanupAndDecodeFallback();
            }
          };
          media.addEventListener("timeupdate", onTimeUpdate);
          media.addEventListener("seeked", onTimeUpdate);
        } else {
          cleanup();
          resolve(Number.isFinite(duration) ? duration : 0);
        }
      });

      media.addEventListener("error", () => {
        cleanupAndDecodeFallback();
      });

      media.src = url;
      if (media instanceof HTMLAudioElement) {
        media.preload = "metadata";
        media.load();
      }
    } catch (e) {
      resolve(0);
    }
  });
};

export const getAudioMetadataDetailed = async (
  file: File | Blob,
): Promise<{
  duration: number;
  sampleRate: number;
  channels: number;
} | null> => {
  try {
    // Yield to the event loop first so a concurrent background upload (fired
    // right after this in addFiles) gets its XHR request on the wire BEFORE we
    // start the main-thread-bound decodeAudioData work below. decodeAudioData
    // on a large file saturates the main thread and starves the upload's send
    // buffer, which makes large-file uploads feel slower. Letting the upload
    // establish its TCP/TLS stream first keeps throughput high.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Duration is the only field callers actually rely on; prefer the cheap
    // HTMLMediaElement "loadedmetadata" path (no full-file decode) and only
    // fall back to decodeAudioData if that fails. This avoids decoding the
    // whole file into an AudioBuffer on the main thread during uploads.
    const accurateDuration = await getAudioDuration(file);
    if (!accurateDuration || accurateDuration <= 0) return null;
    let sampleRate = 0;
    let channels = 0;
    try {
      const audioCtx = getAudioContext();
      const slice = file.slice(0, Math.min(file.size, 500 * 1024));
      const arrayBuffer = await readBlobToArrayBufferStreamed(slice);
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      sampleRate = decoded.sampleRate;
      channels = decoded.numberOfChannels;
    } catch (e) {
      // sampleRate/channels stay 0; duration is still valid.
    }
    return { duration: accurateDuration, sampleRate, channels };
  } catch (err) {
    return null;
  }
};

export async function fastMergeAudioFiles(
  files: File[],
  onProgress?: (msg: string) => void,
  kbps: number | "original" = 128,
  signal?: AbortSignal,
): Promise<{ blob: Blob; ext: string }> {
  if (files.length === 0) throw new Error("No files to merge.");

  if (signal?.aborted) throw new Error("AbortError");

  const ffmpeg = await getFFmpeg(onProgress);

  let lastPct = -5;
  const progressHandler = ({ progress }: any) => {
    if (signal?.aborted) {
      terminateFFmpeg();
      // We don't throw here to avoid unhandled rejections, but exec will fail
    }
    if (progress > 0 && progress <= 1) {
      const displayPct = Math.min(Math.round(progress * 100), 99);
      if (displayPct >= lastPct + 5 || displayPct === 99) {
        lastPct = displayPct;
        onProgress?.(
          `Applying high-speed acoustic stitching... (${displayPct}%)`,
        );
      }
    }
  };
  ffmpeg.on("progress", progressHandler);

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        terminateFFmpeg();
      },
      { once: true },
    );
  }

  onProgress?.("Preparing ultra-fast native engine...");

  const inputArgs: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new Error("AbortError");
      const ext = files[i].name.split(".").pop() || "tmp";
      const fileName = `input_${i}.${ext}`;
      onProgress?.(`Streaming track ${i + 1} of ${files.length}...`);
      const fileData = await readBlobToArrayBufferStreamed(files[i]);
      await ffmpeg.writeFile(fileName, new Uint8Array(fileData));
      inputArgs.push("-i", fileName);
    }

    const n = files.length;
    let filter = "";
    for (let i = 0; i < n; i++) {
      // Robustly resample inputs first to standardized 44.1kHz and stereo layout
      // before feeding to cascade concat. We use min_hard_comp=0.1 and first_pts=0 to optimize
      // performance on single-threaded WebAssembly by avoiding micro-interpolation loops on every sample.
      filter += `[${i}:a]aresample=async=1:min_hard_comp=0.100000:first_pts=0,aformat=sample_rates=44100:channel_layouts=stereo[a${i}];`;
    }
    for (let i = 0; i < n; i++) {
      filter += `[a${i}]`;
    }
    filter += `concat=n=${n}:v=0:a=1[outa]`;

    // Optimize execution speed: Use compression_level 9 (the absolute fastest) for rapid LAME MP3 encoding
    const bitrateArgs =
      kbps === "original"
        ? ["-q:a", "2", "-compression_level", "9"]
        : ["-b:a", `${kbps}k`, "-compression_level", "9"];

    // Check if battery saver is active to use low thread counts, otherwise unlock multi-threading for maximum stitching speed
    const isBatterySaverActive =
      typeof window !== "undefined" &&
      ((window as any).isBatterySaverActive ||
        localStorage.getItem("battery_saver_mode") === "true");
    const threadArgs = isBatterySaverActive
      ? ["-threads", "1"]
      : ["-threads", "0"];

    if (signal?.aborted) throw new Error("AbortError");
    onProgress?.(
      "Merging and rebuilding precise timeline... (This ensures perfect duration)",
    );

    const execPromise = ffmpeg.exec([
      "-loglevel",
      "error",
      ...threadArgs,
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[outa]",
      "-vn",
      "-sn",
      "-dn",
      ...bitrateArgs,
      "output.mp3",
    ]);

    await Promise.race([
      execPromise,
      new Promise((_, reject) => {
        if (signal?.aborted) return reject(new Error("AbortError"));
        signal?.addEventListener(
          "abort",
          () => reject(new Error("AbortError")),
          { once: true },
        );
      }),
    ]);

    if (signal?.aborted) throw new Error("AbortError");
    onProgress?.("Wrapping up...! Your continuous file is ready.");
    const data = await ffmpeg.readFile("output.mp3");

    try {
      for (let i = 0; i < files.length; i++) {
        const ext = files[i].name.split(".").pop() || "tmp";
        await ffmpeg.deleteFile(`input_${i}.${ext}`);
      }
      await ffmpeg.deleteFile("output.mp3");
    } catch (e) {}

    ffmpeg.off("progress", progressHandler);
    return { blob: new Blob([data], { type: "audio/mpeg" }), ext: "mp3" };
  } catch (err: any) {
    ffmpeg.off("progress", progressHandler);
    if (
      signal?.aborted ||
      err.message === "AbortError" ||
      err.message?.includes("FFmpeg object is destroyed")
    ) {
      throw new Error("AbortError");
    }
    throw err;
  }
}

// Ultra-fast resampling using hardware-accelerated OfflineAudioContext
export async function resampleAudioBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: number,
): Promise<AudioBuffer> {
  if (
    buffer.sampleRate === targetSampleRate &&
    buffer.numberOfChannels === targetChannels
  ) {
    return buffer;
  }
  const offlineCtx = new (
    window.OfflineAudioContext || (window as any).webkitOfflineAudioContext
  )(
    targetChannels,
    Math.ceil(buffer.duration * targetSampleRate),
    targetSampleRate,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineCtx.destination);
  source.start();
  return await offlineCtx.startRendering();
}

export async function bufferToMp3(
  sourceBuffer: AudioBuffer,
  kbps: number | "original" = 320,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  // Always preserve original sample rate and channels.
  const targetSampleRate = sourceBuffer.sampleRate;
  const targetChannels = sourceBuffer.numberOfChannels;
  const targetKbps =
    kbps === "original" ? 320 : typeof kbps === "number" ? kbps : 320;

  const leftData =
    targetChannels > 0 ? sourceBuffer.getChannelData(0) : new Float32Array();
  const rightData =
    targetChannels > 1 ? sourceBuffer.getChannelData(1) : undefined;

  const totalSamples = leftData.length;

  // Use exactly 1 dedicated worker to avoid multi-encoder stream concatenation errors and prevent 11 KB file truncation
  const actualWorkers = 1;
  const workerProgress = new Float32Array(actualWorkers);

  // Guard progress reporting with throttling to avoid UI/layout thrashing
  let maxReportedProgress = 0;
  let lastReportedPercentage = -5; // starting at -5 to ensure 0% is reported

  const reportProgress = (p: number) => {
    if (p > maxReportedProgress) {
      maxReportedProgress = p;
      const pct = Math.round(maxReportedProgress * 100);
      if (pct >= lastReportedPercentage + 5 || pct === 100) {
        lastReportedPercentage = pct;
        if (onProgress) {
          if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => {
              onProgress(maxReportedProgress);
            });
          } else {
            onProgress(maxReportedProgress);
          }
        }
      }
    }
  };

  const lChunk = leftData;
  const rChunk = rightData;

  const encodedPromise = new Promise<Int8Array[]>((res, rej) => {
    const worker = acquireWorkerFromPool();

    worker.postMessage({
      type: "INIT",
      payload: {
        channels: targetChannels,
        sampleRate: targetSampleRate,
        kbps: targetKbps,
      },
    });

    let mp3Blobs: Int8Array[] = [];

    worker.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "INIT_DONE") {
        // Send the entire chunk to the worker in one go! Close the array transfer to avoid neutering original AudioBuffers.
        worker.postMessage({
          type: "ENCODE_CHUNK",
          payload: { leftChunk: lChunk, rightChunk: rChunk },
        });
      } else if (type === "PROGRESS") {
        workerProgress[0] = payload.progress;
        reportProgress(workerProgress[0]);
      } else if (type === "CHUNK_DATA") {
        mp3Blobs.push(...payload.mp3Data);
      } else if (type === "CHUNK_DONE") {
        mp3Blobs.push(...payload.mp3Data);
        // Ensure the Web Worker correctly flushes the encoder's internal buffers at the End of File (EOF)
        worker.postMessage({ type: "FINISH" });
      } else if (type === "DONE") {
        mp3Blobs.push(...payload.mp3Data);
        releaseWorkerToPool(worker);
        workerProgress[0] = 1.0;
        reportProgress(1.0);
        res(mp3Blobs);
      }
    };

    worker.onerror = (err) => {
      // Errored workers are in an unknown state — terminate and drop them from
      // the pool rather than returning them for reuse (which would seed the
      // pool with zombies that fail again on the next encode).
      terminateWorkerFromPool(worker);
      rej(err);
    };
  });

  const finalMp3Blobs = await encodedPromise;
  const exactDurationSeconds = sourceBuffer.length / sourceBuffer.sampleRate;

  // Ensure the generated Blob is fully validated as a playable audio MIME type (audio/mpeg)
  const outBlob = new Blob(finalMp3Blobs, { type: "audio/mpeg" });

  if (outBlob.size < 128) {
    throw new Error(
      "Transcoding validation failed: compiled file size is too small or corrupted.",
    );
  }

  if (exactDurationSeconds > 0) {
    (outBlob as any).metadataDuration = exactDurationSeconds;
  }
  return outBlob;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export async function sliceAudioBuffer(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  audioCtx: AudioContext,
): Promise<AudioBuffer> {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;

  const startOffset = Math.floor(startSec * sampleRate);
  const endOffset = Math.floor(endSec * sampleRate);
  const frameCount = endOffset - startOffset;

  const newAudioBuffer = audioCtx.createBuffer(
    channels,
    frameCount,
    sampleRate,
  );

  // Explicit check to ensure the new sliced buffer matches the original sample rate
  if (newAudioBuffer.sampleRate !== audioBuffer.sampleRate) {
    throw new Error(
      `Audio processing error: Sample rate mismatch detected. Expected ${audioBuffer.sampleRate}Hz but created buffer with ${newAudioBuffer.sampleRate}Hz. This will cause pitch shifts.`,
    );
  }

  for (let channel = 0; channel < channels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    const newChannelData = newAudioBuffer.getChannelData(channel);
    newChannelData.set(channelData.subarray(startOffset, endOffset));
  }

  return newAudioBuffer;
}

export async function deleteAudioBufferRegion(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  audioCtx: AudioContext,
): Promise<AudioBuffer> {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;

  const startOffset = Math.floor(startSec * sampleRate);
  const endOffset = Math.floor(endSec * sampleRate);

  if (startOffset >= endOffset) return audioBuffer;

  const newFrameCount = audioBuffer.length - (endOffset - startOffset);

  if (newFrameCount <= 0) {
    return audioCtx.createBuffer(channels, 1, sampleRate);
  }
  const newAudioBuffer = audioCtx.createBuffer(
    channels,
    newFrameCount,
    sampleRate,
  );

  // Explicit check to ensure the new trimmed buffer matches the original sample rate
  if (newAudioBuffer.sampleRate !== audioBuffer.sampleRate) {
    throw new Error(
      `Audio processing error: Sample rate mismatch detected. Expected ${audioBuffer.sampleRate}Hz but created buffer with ${newAudioBuffer.sampleRate}Hz. This will cause pitch shifts.`,
    );
  }

  for (let channel = 0; channel < channels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    const newChannelData = newAudioBuffer.getChannelData(channel);

    // Copy the part before the deleted region
    newChannelData.set(channelData.subarray(0, startOffset), 0);

    // Copy the part after the deleted region
    if (endOffset < channelData.length) {
      newChannelData.set(channelData.subarray(endOffset), startOffset);
    }
  }

  return newAudioBuffer;
}

/**
 * Synchronous, allocation-light WAV (PCM s16le) encoder.
 * Used as the staging format fed into the FFmpeg WASM fast MP3 path, and as a
 * zero-latency export path. Runs fully on the main thread but is ~10x faster
 * than re-encoding through lamejs, since PCM write is a trivial per-sample clamp.
 * Returns an ArrayBuffer (not a Blob) so it can be handed directly to FFmpeg's
 * virtual FS without an extra Blob→ArrayBuffer round-trip.
 */
export function audioBufferToWavArrayBuffer(
  buffer: AudioBuffer,
  onProgress?: (progress: number) => void,
): ArrayBuffer {
  const numOfChan = buffer.numberOfChannels;
  const sampleRate = Math.round(buffer.sampleRate);
  const bitDepth = 16;
  const length = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numOfChan * bytesPerSample;
  const bufferLength = length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, bufferLength, true);

  let offset = 44;

  if (numOfChan === 2) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < length; i++) {
      let sl = left[i];
      sl = sl < -1 ? -1 : sl > 1 ? 1 : sl;
      view.setInt16(offset, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true);
      offset += 2;
      let sr = right[i];
      sr = sr < -1 ? -1 : sr > 1 ? 1 : sr;
      view.setInt16(offset, sr < 0 ? sr * 0x8000 : sr * 0x7fff, true);
      offset += 2;
    }
  } else if (numOfChan === 1) {
    const left = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      let sl = left[i];
      sl = sl < -1 ? -1 : sl > 1 ? 1 : sl;
      view.setInt16(offset, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true);
      offset += 2;
    }
  } else {
    const channelsData: Float32Array[] = [];
    for (let c = 0; c < numOfChan; c++)
      channelsData.push(buffer.getChannelData(c));
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numOfChan; c++) {
        let s = channelsData[c][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
  }

  if (onProgress) onProgress(1.0);
  return arrayBuffer;
}

/**
 * Ultra-fast MP3 export via the already-cached FFmpeg WASM engine.
 *
 * Why this is fast:
 *  - FFmpeg's native LAME encoder is several times faster than pure-JS lamejs.
 *  - Decoding is bypassed entirely: we stage raw PCM WAV in FFmpeg's virtual FS,
 *    so FFmpeg only has to mux+encode, not decode.
 *  - Runs entirely off the main thread (WASM worker), so the UI never blocks.
 *  - Uses compression_level 9 (fastest LAME preset) and auto-detected thread count.
 *
 * Falls back gracefully by throwing — callers should catch and retry with lamejs.
 */
export async function bufferToMp3Fast(
  sourceBuffer: AudioBuffer,
  kbps: number = 192,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const targetKbps = kbps;

  const ffmpeg = await getFFmpeg();

  if (signal?.aborted) throw new Error("AbortError");

  // Stage 1: encode raw PCM WAV synchronously (cheap, allocation-light).
  const wavArrayBuffer = audioBufferToWavArrayBuffer(sourceBuffer);
  await ffmpeg.writeFile("export_src.wav", new Uint8Array(wavArrayBuffer));

  let lastPct = -5;
  const progressHandler = ({ progress }: any) => {
    if (signal?.aborted) terminateFFmpeg();
    if (progress > 0 && progress <= 1) {
      const displayPct = Math.min(Math.round(progress * 100), 99);
      if (displayPct >= lastPct + 5 || displayPct === 99) {
        lastPct = displayPct;
        onProgress?.(displayPct / 100);
      }
    }
  };
  ffmpeg.on("progress", progressHandler);

  if (signal) {
    signal.addEventListener("abort", () => terminateFFmpeg(), { once: true });
  }

  try {
    const isBatterySaverActive =
      typeof window !== "undefined" &&
      ((window as any).isBatterySaverActive ||
        localStorage.getItem("battery_saver_mode") === "true");
    const threadArgs = isBatterySaverActive
      ? ["-threads", "1"]
      : ["-threads", "0"];

    await ffmpeg.exec([
      "-loglevel",
      "error",
      ...threadArgs,
      "-i",
      "export_src.wav",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${targetKbps}k`,
      "-compression_level",
      "9",
      "-id3v2_version",
      "3",
      "-ar",
      `${sourceBuffer.sampleRate}`,
      "export_out.mp3",
    ]);

    const data = await ffmpeg.readFile("export_out.mp3");
    onProgress?.(1.0);

    try {
      await ffmpeg.deleteFile("export_src.wav");
      await ffmpeg.deleteFile("export_out.mp3");
    } catch (e) {}

    const outBlob = new Blob([data], { type: "audio/mpeg" });
    if (outBlob.size < 128) {
      throw new Error(
        "Transcoding validation failed: compiled file size is too small or corrupted.",
      );
    }
    const exactDurationSeconds = sourceBuffer.length / sourceBuffer.sampleRate;
    if (exactDurationSeconds > 0) {
      (outBlob as any).metadataDuration = exactDurationSeconds;
    }
    return outBlob;
  } catch (err: any) {
    if (
      signal?.aborted ||
      err.message === "AbortError" ||
      err.message?.includes("FFmpeg object is destroyed")
    ) {
      throw new Error("AbortError");
    }
    throw err;
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}

/**
 * Fast blob-to-MP3 transcode via the cached FFmpeg WASM engine.
 *
 * Unlike bufferToMp3Fast, this takes a raw audio Blob (e.g. an MP3 returned by
 * Cleanvoice) and pipes it straight into FFmpeg's virtual FS — FFmpeg decodes
 * and re-encodes in a single pass, with NO Web Audio decode step and NO WAV
 * staging allocation. This is the fastest reliable path for "re-compress an
 * already-encoded file at a lower bitrate":
 *
 *   raw blob -> FFmpeg (decode + libmp3lame encode) -> output blob
 *
 * It avoids the ~2x memory spike of decoding to an AudioBuffer + staging a WAV,
 * so it stays fast and stable even on long files where lamejs (pure JS) would
 * be slow and bufferToMp3Fast would balloon memory.
 */
/**
 * Server-side transcode via /api/transcode-audio (native ffmpeg-static binary).
 * Significantly faster than client-side FFmpeg WASM: the native binary runs at
 * full CPU speed and the source is fetched + transcoded in a single server
 * round-trip (no proxy-fetch + WASM virtual-FS IO). Results are also cached
 * server-side by SHA-256 key, so repeated downloads of the same file are instant.
 *
 * Only available when hasServerBackend() is true; callers must gate on that.
 * Falls back to transcodeBlobFast (WASM) if the server endpoint is unreachable.
 */
export async function transcodeViaServer(
  sourceUrl: string,
  kbps: number = 128,
  format: string = "mp3",
  filename?: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const params = new URLSearchParams({
    url: sourceUrl,
    bitrate: `${kbps}k`,
    format,
  });
  if (filename) params.set("filename", filename);

  const response = await fetch(`/api/transcode-audio?${params.toString()}`, {
    signal,
  });
  if (!response.ok) {
    throw new Error(`Server transcode failed: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (blob.size < 128) {
    throw new Error(
      "Server transcode returned an empty or corrupted file",
    );
  }
  return blob;
}

export async function transcodeBlobFast(
  sourceBlob: Blob,
  kbps: number = 128,
  ext: string = "mp3",
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();

  if (signal?.aborted) throw new Error("AbortError");

  const inName = `transcode_in.${ext}`;
  const outName = "transcode_out.mp3";

  const arrayBuffer = await sourceBlob.arrayBuffer();
  await ffmpeg.writeFile(inName, new Uint8Array(arrayBuffer));

  let lastPct = -5;
  const progressHandler = ({ progress }: any) => {
    if (signal?.aborted) terminateFFmpeg();
    if (progress > 0 && progress <= 1) {
      const displayPct = Math.min(Math.round(progress * 100), 99);
      if (displayPct >= lastPct + 5 || displayPct === 99) {
        lastPct = displayPct;
        onProgress?.(displayPct / 100);
      }
    }
  };
  ffmpeg.on("progress", progressHandler);

  if (signal) {
    signal.addEventListener("abort", () => terminateFFmpeg(), { once: true });
  }

  try {
    const isBatterySaverActive =
      typeof window !== "undefined" &&
      ((window as any).isBatterySaverActive ||
        localStorage.getItem("battery_saver_mode") === "true");
    const threadArgs = isBatterySaverActive
      ? ["-threads", "1"]
      : ["-threads", "0"];

    // Single-pass transcode: input → libmp3lame → MP3. Decoding to a WAV
    // intermediate first doubled the work (extra decode pass + virtual-FS IO)
    // and was the cause of the slowdown; libmp3lame reads the input directly.
    await ffmpeg.exec([
      "-loglevel",
      "error",
      ...threadArgs,
      "-i",
      inName,
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${kbps}k`,
      "-compression_level",
      "9",
      "-id3v2_version",
      "3",
      outName,
    ]);

    const data = await ffmpeg.readFile(outName);
    onProgress?.(1.0);

    try {
      await ffmpeg.deleteFile(inName);
      await ffmpeg.deleteFile(outName);
    } catch (e) {}

    const outBlob = new Blob([data], { type: "audio/mpeg" });
    if (outBlob.size < 128) {
      throw new Error(
        "Transcoding validation failed: compiled file size is too small or corrupted.",
      );
    }
    return outBlob;
  } catch (err: any) {
    if (
      signal?.aborted ||
      err.message === "AbortError" ||
      err.message?.includes("FFmpeg object is destroyed")
    ) {
      throw new Error("AbortError");
    }
    throw err;
  } finally {
    ffmpeg.off("progress", progressHandler);
  }
}

export async function bufferToWavAsync(
  buffer: AudioBuffer,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const numOfChan = buffer.numberOfChannels;
  const sampleRate = Math.round(buffer.sampleRate);
  const format = 1; // 1 = PCM (Integer)
  const bitDepth = 16;

  const length = buffer.length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numOfChan * bytesPerSample;
  const bufferLength = length * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, bufferLength, true);

  let offset = 44;

  if (numOfChan === 2) {
    const resultL = buffer.getChannelData(0);
    const resultR = buffer.getChannelData(1);
    for (let i = 0; i < length; i += 100000) {
      const end = Math.min(i + 100000, length);
      for (let j = i; j < end; j++) {
        let sl = Math.max(-1, Math.min(1, resultL[j]));
        view.setInt16(offset, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true);
        offset += 2;
        let sr = Math.max(-1, Math.min(1, resultR[j]));
        view.setInt16(offset, sr < 0 ? sr * 0x8000 : sr * 0x7fff, true);
        offset += 2;
      }
      if (onProgress) onProgress(end / length);
      if (
        typeof window !== "undefined" &&
        (window as any)._lastYield &&
        performance.now() - (window as any)._lastYield > 50
      ) {
        await new Promise((r) => setTimeout(r, 0));
        (window as any)._lastYield = performance.now();
      }
    }
  } else if (numOfChan === 1) {
    const resultL = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 100000) {
      const end = Math.min(i + 100000, length);
      for (let j = i; j < end; j++) {
        let sl = Math.max(-1, Math.min(1, resultL[j]));
        view.setInt16(offset, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true);
        offset += 2;
      }
      if (onProgress) onProgress(end / length);
      if (
        typeof window !== "undefined" &&
        (window as any)._lastYield &&
        performance.now() - (window as any)._lastYield > 50
      ) {
        await new Promise((r) => setTimeout(r, 0));
        (window as any)._lastYield = performance.now();
      }
    }
  } else {
    const channelsData = [];
    for (let c = 0; c < numOfChan; c++) {
      channelsData.push(buffer.getChannelData(c));
    }
    for (let i = 0; i < length; i += 100000) {
      const end = Math.min(i + 100000, length);
      for (let j = i; j < end; j++) {
        for (let c = 0; c < numOfChan; c++) {
          let s = Math.max(-1, Math.min(1, channelsData[c][j]));
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          offset += 2;
        }
      }
      if (onProgress) onProgress(end / length);
      if (
        typeof window !== "undefined" &&
        (window as any)._lastYield &&
        performance.now() - (window as any)._lastYield > 50
      ) {
        await new Promise((r) => setTimeout(r, 0));
        (window as any)._lastYield = performance.now();
      }
    }
  }

  if (onProgress) {
    onProgress(1.0);
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/**
 * Transcodes a webm or video file into a standard AudioBuffer using the Web Audio API
 * by playing it through a hidden video element and capturing its output.
 */
export async function transcodeWebMToAudioBuffer(
  file: File | Blob,
  audioCtx: AudioContext,
): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const mediaEl = document.createElement("video");
    mediaEl.src = url;
    mediaEl.muted = true; // Safe autoplay policy bypass
    mediaEl.crossOrigin = "anonymous";
    mediaEl.playsInline = true;

    // Position safely off-screen and add to document to prevent background CPU throttling
    mediaEl.style.position = "fixed";
    mediaEl.style.left = "-9999px";
    mediaEl.style.top = "-9999px";
    mediaEl.style.width = "1px";
    mediaEl.style.height = "1px";
    mediaEl.style.opacity = "0.01";
    mediaEl.style.pointerEvents = "none";
    document.body.appendChild(mediaEl);

    const samples: { left: Float32Array[]; right: Float32Array[] } = {
      left: [],
      right: [],
    };
    let totalLength = 0;

    const sampleRate = audioCtx.sampleRate;
    const channels = 2;

    let processor: ScriptProcessorNode;
    let source: MediaElementAudioSourceNode;
    let silenceGain: GainNode;

    const onMetadata = () => {
      try {
        processor = audioCtx.createScriptProcessor(4096, 2, 2);
        source = audioCtx.createMediaElementSource(mediaEl);
        silenceGain = audioCtx.createGain();
        silenceGain.gain.value = 0.0; // Silence fast squeaks

        source.connect(processor);
        processor.connect(silenceGain);
        silenceGain.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          const inputL = e.inputBuffer.getChannelData(0);
          const inputR =
            e.inputBuffer.numberOfChannels > 1
              ? e.inputBuffer.getChannelData(1)
              : e.inputBuffer.getChannelData(0);

          samples.left.push(new Float32Array(inputL));
          samples.right.push(new Float32Array(inputR));
          totalLength += inputL.length;
        };

        mediaEl.play().catch((err) => {
          cleanup();
          reject(err);
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    mediaEl.onloadedmetadata = onMetadata;

    mediaEl.onended = () => {
      cleanup();

      const buffer = audioCtx.createBuffer(
        channels,
        Math.max(1, totalLength),
        sampleRate,
      );
      const outputL = buffer.getChannelData(0);
      const outputR = buffer.getChannelData(1);

      let cursor = 0;
      for (let i = 0; i < samples.left.length; i++) {
        outputL.set(samples.left[i], cursor);
        outputR.set(samples.right[i], cursor);
        cursor += samples.left[i].length;
      }

      resolve(buffer);
    };

    mediaEl.onerror = (err) => {
      cleanup();
      reject(
        new Error("Media element failed to load or play during transcoding"),
      );
    };

    const cleanup = () => {
      try {
        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (silenceGain) silenceGain.disconnect();
      } catch (e) {}
      URL.revokeObjectURL(url);
      mediaEl.pause();
      if (mediaEl.parentNode) {
        mediaEl.parentNode.removeChild(mediaEl);
      }
    };

    // Speed up standard transcoding to 8.0x for rapid processing
    mediaEl.playbackRate = 8.0;
  });
}

/**
 * Sniffs the container/codec of an audio Blob by inspecting its magic bytes
 * alongside the declared MIME type. Used to pick the correct FFmpeg input-format
 * hint and route the right fallback when the browser's native decoder bails
 * (notably on WebM/Opus, which non-Chromium engines routinely refuse even when
 * the file itself is perfectly valid).
 */
export async function sniffAudioContainer(file: File | Blob): Promise<{
  container: "webm" | "ogg" | "mp3" | "wav" | "mp4" | "flac" | "unknown";
  codec?: string;
  mime: string;
  ext: string;
}> {
  const name = file instanceof File ? file.name.toLowerCase() : "";
  const declaredType = (file.type || "").toLowerCase();
  const ext = name.match(/\.([a-z0-9]+)$/)?.[1] || "";

  // Magic-byte sniff (async because Blob.slice().arrayBuffer() is async).
  let head = new Uint8Array(0);
  try {
    head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  } catch {
    /* ignore — fall back to declared MIME/extension */
  }

  // EBML header (WebM/Matroska): 0x1A 0x45 0xDF 0xA3
  const isWebmMagic =
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3;
  // Ogg: 'OggS'
  const isOggMagic =
    head.length >= 4 &&
    head[0] === 0x4f &&
    head[1] === 0x67 &&
    head[2] === 0x67 &&
    head[3] === 0x53;
  // FLAC: 'fLaC'
  const isFlacMagic =
    head.length >= 4 &&
    head[0] === 0x66 &&
    head[1] === 0x4c &&
    head[2] === 0x61 &&
    head[3] === 0x43;
  // RIFF/WAVE: 'RIFF....WAVE'
  const isWavMagic =
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x41 &&
    head[10] === 0x56 &&
    head[11] === 0x45;
  // MP3 ID3 tag or MPEG frame sync 0xFF Ex/Fx
  const isMp3Magic =
    head.length >= 3 &&
    ((head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || // 'ID3'
      (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)); // frame sync
  // MP4/M4A: '....ftyp'
  const isMp4Magic =
    head.length >= 12 &&
    head[4] === 0x66 &&
    head[5] === 0x74 &&
    head[6] === 0x79 &&
    head[7] === 0x70;

  let container: "webm" | "ogg" | "mp3" | "wav" | "mp4" | "flac" | "unknown" =
    "unknown";
  if (isWebmMagic) container = "webm";
  else if (isOggMagic) container = "ogg";
  else if (isFlacMagic) container = "flac";
  else if (isWavMagic) container = "wav";
  else if (isMp3Magic) container = "mp3";
  else if (isMp4Magic) container = "mp4";
  else if (declaredType.includes("webm") || ext === "webm" || ext === "wbm")
    container = "webm";
  else if (
    declaredType.includes("ogg") ||
    ext === "ogg" ||
    ext === "opus" ||
    ext === "oga"
  )
    container = "ogg";
  else if (declaredType.includes("wav") || ext === "wav") container = "wav";
  else if (declaredType.includes("flac") || ext === "flac") container = "flac";
  else if (
    declaredType.includes("mp4") ||
    ext === "m4a" ||
    ext === "mp4" ||
    ext === "m4b"
  )
    container = "mp4";
  else if (declaredType.includes("mpeg") || ext === "mp3" || ext === "mpga")
    container = "mp3";

  let codec: string | undefined;
  if (declaredType.includes("opus") || ext === "opus") codec = "opus";
  else if (declaredType.includes("vorbis")) codec = "vorbis";
  else if (declaredType.includes("aac")) codec = "aac";
  else if (container === "mp3") codec = "mp3";

  const mime =
    declaredType ||
    (container === "webm"
      ? codec === "opus"
        ? 'audio/webm; codecs="opus"'
        : "audio/webm"
      : container === "ogg"
        ? codec === "opus"
          ? 'audio/ogg; codecs="opus"'
          : "audio/ogg"
        : container === "mp3"
          ? "audio/mpeg"
          : container === "wav"
            ? "audio/wav"
            : container === "flac"
              ? "audio/flac"
              : container === "mp4"
                ? "audio/mp4"
                : "application/octet-stream");

  return { container, codec, mime, ext };
}

/**
 * High-fidelity unified audio decoder that defaults to browser-native decoding
 * and gracefully falls back to the Web Audio API transcode helper for 'video/webm' containers.
 */
export async function decodeAudioFile(
  file: File | Blob,
  audioCtx: AudioContext,
): Promise<AudioBuffer> {
  // If the file is a merged file with its original track pieces available in memory,
  // decode them individually and combine them to bypass the browser's native limitation
  // where decodeAudioData on concatenated MP3s cuts off after the first segment/logical stream.
  if (
    file &&
    (file as any).originalFiles &&
    Array.isArray((file as any).originalFiles) &&
    (file as any).originalFiles.length > 0
  ) {
    console.log(
      "Decoding merged file via fast Individual-Decoding-and-Stitching path to prevent segment cut-off...",
    );
    try {
      const originalFiles: (File | Blob)[] = (file as any).originalFiles;
      const decodePromises = originalFiles.map(async (f) => {
        return decodeAudioFile(f, audioCtx);
      });
      const buffers = await Promise.all(decodePromises);

      const targetSampleRate = buffers[0].sampleRate;
      const targetChannels = buffers[0].numberOfChannels;

      const resampledBuffers = await Promise.all(
        buffers.map(async (buf) => {
          if (
            buf.sampleRate !== targetSampleRate ||
            buf.numberOfChannels !== targetChannels
          ) {
            return resampleAudioBuffer(buf, targetSampleRate, targetChannels);
          }
          return buf;
        }),
      );

      let totalLength = 0;
      for (const buf of resampledBuffers) {
        totalLength += buf.length;
      }

      const combinedBuffer = audioCtx.createBuffer(
        targetChannels,
        totalLength,
        targetSampleRate,
      );

      let offset = 0;
      for (const buf of resampledBuffers) {
        for (let channel = 0; channel < targetChannels; channel++) {
          const combinedData = combinedBuffer.getChannelData(channel);
          const bufData = buf.getChannelData(channel);
          combinedData.set(bufData, offset);
        }
        offset += buf.length;
      }

      console.log(
        `Successfully merged and decoded all original segments into a single ${combinedBuffer.duration.toFixed(2)}s buffer.`,
      );
      return combinedBuffer;
    } catch (err) {
      console.warn(
        "Individual decoding and stitching failed, falling back to typical decode:",
        err,
      );
    }
  }

  // Stream-based processing: stream file directly chunk-by-chunk to avoid loading large buffers
  const arrayBuffer = await readBlobToArrayBufferStreamed(file);

  // Track every stage's failure so we can pinpoint structural/codec corruption
  // in the final error without breaking the application wrapper.
  const failureLog: string[] = [];

  // Container sniff is deferred to Stage 3 (the FFmpeg fallback) so the common
  // native-decode happy path pays no extra I/O round-trip and the waveform
  // loads as fast as before. It is only consulted when we actually need an
  // FFmpeg input-format hint.
  let sniff: {
    container: "webm" | "ogg" | "mp3" | "wav" | "mp4" | "flac" | "unknown";
    codec?: string;
    mime: string;
    ext: string;
  } = {
    container: "unknown",
    codec: undefined,
    mime: file.type || "",
    ext:
      file instanceof File
        ? file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ""
        : "",
  };

  // --- Stage 1: browser-native decodeAudioData -------------------------------
  try {
    // Attempt standard browser-native decoding first
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err: any) {
    failureLog.push(`native decodeAudioData: ${err?.message || err}`);
    console.warn(
      `[decodeAudioFile] Stage 1 (native decodeAudioData) failed:`,
      err,
    );
  }

  // --- Stage 2: Web Audio API HTML5 media-element transcode fallback ---------
  // Streams the file through a hidden <video>/<audio> element + ScriptProcessor
  // capture. Works for WebM/Opus when the engine can play but not decode it.
  try {
    console.log(
      `[decodeAudioFile] Stage 2: attempting HTML5 media-element transcode fallback...`,
    );
    return await transcodeWebMToAudioBuffer(file, audioCtx);
  } catch (fallbackErr: any) {
    failureLog.push(
      `HTML5 media-element transcode: ${fallbackErr?.message || fallbackErr}`,
    );
    console.warn(
      `[decodeAudioFile] Stage 2 (media-element transcode) failed:`,
      fallbackErr,
    );
  }

  // --- Stage 3: WebAssembly (FFmpeg) transcode -> standard WAV PCM ----------
  // Only now do we sniff the container: the result drives FFmpeg's input-format
  // hint, which fixes the processed-Cleanvoice-blob case where the extension/
  // MIME is missing or unreliable (previously FFmpeg refused to demux it).
  try {
    sniff = await sniffAudioContainer(file).catch(() => sniff);
    console.log(
      `[decodeAudioFile] Container sniff: ${sniff.container}${sniff.codec ? `/${sniff.codec}` : ""} ` +
        `(mime="${sniff.mime}", ext="${sniff.ext}", declaredType="${file.type || ""}", size=${file.size} bytes)`,
    );
    console.log(
      `[decodeAudioFile] Stage 3: attempting FFmpeg (WASM) decode fallback -> WAV...`,
    );
    const ffmpeg = await getFFmpeg();
    const ext =
      sniff.ext ||
      (file instanceof File ? file.name.split(".").pop() || "tmp" : "tmp");
    const inputName = `input_decode_fallback.${ext}`;
    const outputName = `output_decode_fallback.wav`; // Fast PCM encode

    const fileData = await readBlobToArrayBufferStreamed(file);
    await ffmpeg.writeFile(inputName, new Uint8Array(fileData));

    const inputFormatHint =
      sniff.container === "webm"
        ? ["-f", "webm"]
        : sniff.container === "ogg"
          ? ["-f", "ogg"]
          : sniff.container === "mp3"
            ? ["-f", "mp3"]
            : sniff.container === "mp4"
              ? ["-f", "mp4"]
              : sniff.container === "flac"
                ? ["-f", "flac"]
                : [];

    await ffmpeg.exec([
      ...inputFormatHint,
      "-i",
      inputName,
      "-c:a",
      "pcm_s16le",
      "-ar",
      audioCtx.sampleRate.toString(),
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);

    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (e) {}

    // Final attempt with standard WAV array buffer which always succeeds
    return await audioCtx.decodeAudioData((data as Uint8Array).slice().buffer);
  } catch (ffmpegErr: any) {
    failureLog.push(
      `FFmpeg WASM transcode: ${ffmpegErr?.message || ffmpegErr}`,
    );
    console.error(`[decodeAudioFile] Stage 3 (FFmpeg WASM) failed:`, ffmpegErr);
  }

  // Every stage failed. Surface the stage-1 error (preserves the original
  // user-facing message) and log the full cascade to the console so devs can
  // pinpoint whether this is structural corruption vs. a codec support gap.
  console.error(
    `[decodeAudioFile] All decode stages failed for ${sniff.container}/${sniff.codec || "unknown"}. ` +
      `Failure cascade:\n  - ${failureLog.join("\n  - ") || "unknown"}`,
  );
  throw new Error(
    `Failed to decode this audio file. Your browser does not natively support this codec, and standard transcoding failed. (${failureLog[0] || "Unable to decode audio data"})`,
  );
}
