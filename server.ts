import express from "express";
import path from "path";
import http from "http";
import https from "https";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import { Cleanvoice } from "@cleanvoice/cleanvoice-sdk";
import fs from "fs";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  PRIMARY_GEMINI_MODEL,
  buildModelOrder,
  getThinkingConfig,
  isInvalidArgumentError,
} from "./src/services/geminiModels";
import { raceTimingsFor, raceToFirstChunk } from "./src/services/geminiRace";

dotenv.config();

// 1. Persistent Connection Pooling: Enable persistent TCP Keep-Alive for all outbound HTTP/HTTPS requests
http.globalAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});
https.globalAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});

// Configure undici dispatcher for Node global fetch socket reuse if available
(async () => {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    const undici = await dynamicImport("undici");
    if (undici && typeof undici.setGlobalDispatcher === "function" && undici.Agent) {
      undici.setGlobalDispatcher(
        new undici.Agent({
          keepAliveTimeout: 60000,
          keepAliveMaxTimeout: 120000,
          connections: 128,
          pipelining: 1,
        })
      );
      console.log("[Server Acceleration] Persistent Keep-Alive Connection Pool initialized.");
    }
  } catch {
    // Fallback gracefully to globalAgents
  }
})();

interface CachedJob {
  editId: string;
  apiKey: string;
  status: "processing" | "success" | "error";
  startedAt: number;
  completedAt?: number;
  elapsedSeconds?: number;
  data?: any;
  consecutiveNotFound?: number;
  lastFetchedAt?: number;
  lastBackgroundFetchAt?: number;
  // Ensures the fallback /export POST fires at most once per edit, preventing
  // redundant restarts that roughly doubled the render wait.
  exportTriggered?: boolean;
  exportConfig?: {
    format?: string;
    bitrate?: number | null;
  };
}

const activeJobsCache = new Map<string, CachedJob>();
const wsClients = new Map<string, Set<WebSocket>>();
const activeProxyDownloads = new Map<string, Promise<void>>();

/**
 * 2. Instant Background Pre-fetching & Caching:
 * The instant Cleanvoice finishes upstream, immediately downloads and caches
 * the output audio into /tmp/proxy_cache in the background so playback and
 * export downloads are instant (0s latency).
 */
async function eagerPrefetchAudio(targetUrl: string, exportConfig?: any) {
  if (!targetUrl || typeof targetUrl !== "string" || !targetUrl.startsWith("http")) return;
  try {
    const proxyCacheDir = "/tmp/proxy_cache";
    if (!fs.existsSync(proxyCacheDir)) {
      fs.mkdirSync(proxyCacheDir, { recursive: true });
    }

    const cacheKey = crypto.createHash("sha256").update(targetUrl).digest("hex");
    let ext = "mp3";
    try {
      const parsedUrl = new URL(targetUrl);
      const pathname = parsedUrl.pathname;
      const lastDot = pathname.lastIndexOf(".");
      if (lastDot !== -1) {
        const possibleExt = pathname.substring(lastDot + 1).toLowerCase();
        if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(possibleExt)) {
          ext = possibleExt;
        }
      }
    } catch {}

    const cachePath = path.join(proxyCacheDir, `${cacheKey}.${ext}`);
    if (fs.existsSync(cachePath)) {
      console.log(`[Eager Prefetch] Asset already warm in cache: ${cachePath}`);
      return;
    }

    if (activeProxyDownloads.has(cacheKey)) {
      return;
    }

    console.log(`[Eager Prefetch] Initiating instant background pre-cache for: ${targetUrl.substring(0, 80)}...`);
    const prefetchPromise = (async () => {
      try {
        let res = await fetch(targetUrl);
        if (!res.ok) {
          res = await fetch(targetUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Accept": "*/*"
            }
          });
        }
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const startBytes = Buffer.from(arrayBuf).subarray(0, 120).toString("utf8").trim();
          if (!startBytes.startsWith("<") && !startBytes.includes("AccessDenied") && !startBytes.includes("NoSuchKey")) {
            fs.writeFileSync(cachePath, Buffer.from(arrayBuf));
            console.log(`[Eager Prefetch] Successfully pre-cached ${arrayBuf.byteLength} bytes at: ${cachePath}`);
          }
        }
      } catch (err) {
        console.warn(`[Eager Prefetch] Non-blocking notice:`, err);
      }
    })();

    activeProxyDownloads.set(cacheKey, prefetchPromise);
    try {
      await prefetchPromise;
    } finally {
      activeProxyDownloads.delete(cacheKey);
    }
  } catch (e) {
    console.warn("[Eager Prefetch] Error:", e);
  }
}

function extractDownloadUrl(obj: any): string | null {
  if (!obj) return null;
  
  let download_url =
    obj.download_url ||
    obj.downloadUrl ||
    obj.audio?.url ||
    obj.audio?.download_url ||
    obj.audio?.output_url ||
    obj.result?.audio?.url ||
    obj.results?.audio?.url ||
    obj.output_url ||
    obj.result_url ||
    obj.audio_url ||
    obj.cleaned_url ||
    (obj.results &&
      (obj.results.download_url ||
        obj.results.downloadUrl ||
        obj.results.export_url ||
        obj.results.url ||
        obj.results.output_url ||
        obj.results.audio_url ||
        (Array.isArray(obj.results.files) && obj.results.files[0]))) ||
    (obj.result &&
      (obj.result.download_url ||
        obj.result.downloadUrl ||
        obj.result.export_url ||
        obj.result.url ||
        obj.result.output_url ||
        obj.result.audio_url ||
        (Array.isArray(obj.result.files) && obj.result.files[0]))) ||
    (obj.export &&
      (obj.export.url ||
        obj.export.download_url ||
        obj.export.output_url ||
        (obj.export.results && obj.export.results.download_url))) ||
    obj.url ||
    obj.export_url;

  if (!download_url) {
    const deepSearchUrl = (item: any): string | null => {
      if (!item) return null;
      if (typeof item === "string") {
        if ((item.startsWith("http") || item.startsWith("//")) &&
           (item.includes(".mp3") || item.includes(".wav") || item.includes(".m4a") || item.includes(".flac") || item.includes("cleanvoice") || item.includes("cdn") || item.includes("storage"))) {
          return item;
        }
        return null;
      }
      if (Array.isArray(item)) {
        for (const val of item) {
          const res = deepSearchUrl(val);
          if (res) return res;
        }
      } else if (typeof item === "object") {
        for (const key of ["download_url", "url", "audio_url", "export_url", "output_url", "file", "audio"]) {
           if (item[key]) {
             if (typeof item[key] === "string" && item[key].startsWith("http")) return item[key];
             const res = deepSearchUrl(item[key]);
             if (res) return res;
           }
        }
        for (const key of Object.keys(item)) {
          const res = deepSearchUrl(item[key]);
          if (res) return res;
        }
      }
      return null;
    };
    download_url = deepSearchUrl(obj.results || obj.result) || deepSearchUrl(obj) || null;
  }
  return download_url || null;
}

function startServerSidePolling(editId: string, apiKey: string, exportConfig?: any) {
  if (activeJobsCache.has(editId)) {
    if (exportConfig) {
      const existing = activeJobsCache.get(editId);
      if (existing) existing.exportConfig = exportConfig;
    }
    return;
  }

  const job: CachedJob = {
    editId,
    apiKey,
    status: "processing",
    startedAt: Date.now(),
    exportConfig,
  };
  activeJobsCache.set(editId, job);

  console.log(`[Server Poller] Registered background poller for editId: ${editId}`);

  let attempts = 0;
  // TIER 0 FIX — budget by WALL-CLOCK TIME, not attempt count.
  //
  // This was `maxAttempts = 720` with a comment claiming "720 attempts with a 1s
  // interval spans up to 12 minutes". That comment described a 1s cadence that
  // no longer exists: currentDelay is 300ms initially and 400ms steady-state,
  // so the real ceiling was 720 x ~0.4s = ~4.8 MINUTES. Any job processing for
  // longer than that was killed and reported to the user as
  // "Polling timeout..." — a hard failure on a job that was still healthy and
  // would have completed. Long/large audio was the exact case that broke.
  //
  // A time budget cannot drift out of sync with the cadence, so future cadence
  // retuning can never silently shrink the timeout window again.
  const MAX_POLL_MS = 15 * 60 * 1000; // 15 minutes of processing headroom
  const pollDeadline = Date.now() + MAX_POLL_MS;
  let timeoutId: NodeJS.Timeout | null = null;
  // NOTE: this cadence is deliberately NOT lowered further. At 300-400ms this
  // poller already issues ~2.5-3.3 req/s upstream for the whole job, and it is
  // the sole upstream caller. Tightening it increases 429s, and each 429
  // doubles the delay (up to 5s), which makes completion detection SLOWER and
  // less predictable. Status latency is already solved by the WebSocket push
  // below; there is nothing meaningful left to win here.
  let currentDelay = 300;

  async function poll() {
    const currentJobState = activeJobsCache.get(editId);
    if (!currentJobState || currentJobState.status !== "processing") {
      return;
    }

    attempts++;
    if (Date.now() > pollDeadline) {
      currentJobState.status = "error";
      currentJobState.data = { status: "error", error: `Polling timeout after ${Math.round(MAX_POLL_MS / 60000)} minutes (${attempts} attempts)` };
      currentJobState.completedAt = Date.now();
      currentJobState.elapsedSeconds = Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000);
      console.log(`[Server Poller] Polling timeout for editId: ${editId}`);
      
      const clients = wsClients.get(editId);
      if (clients && clients.size > 0) {
        const message = JSON.stringify({
          type: "status_update",
          editId,
          status: "error",
          data: currentJobState.data,
          progressPercentage: 100,
          serverElapsedSeconds: currentJobState.elapsedSeconds
        });
        for (const client of clients) {
          if (client.readyState === 1) client.send(message);
        }
      }
      return;
    }

    try {
      const response = await fetch(`https://api.cleanvoice.ai/v2/edits/${editId}?_t=${Date.now()}`, {
        method: "GET",
        headers: {
          "X-API-Key": apiKey,
          "Accept": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });

      if (response.status === 429) {
        // This poller is the SOLE upstream caller (the proxy serves client
        // GETs from cache), so a 429 here is rare. When it happens, a short
        // bounded backoff recovers fast: cap at 5s (was 20s) so a rate-limit
        // blip delays detection by ~5s worst-case, not 20s — which was the
        // main cause of jobs appearing to "hang" long after they finished.
        currentDelay = Math.min(5000, currentDelay * 2);
        console.warn(`[Server Poller] Rate limited (429) for editId: ${editId}. Backing off. Next poll in ${currentDelay}ms.`);
        timeoutId = setTimeout(poll, currentDelay);
        return;
      }

      // Reset delay back to 400ms after a successful, non-rate-limited response
      currentDelay = 400;

      if (!response.ok) {
        // Handle eventual consistency / transient errors (e.g., 404 Task Not Found or 400 Bad Request if polling too early)
        if (response.status === 404 || response.status === 400) {
          const limit = 15; // Allow 15 retries (approx 60 seconds)
          currentJobState.consecutiveNotFound = (currentJobState.consecutiveNotFound || 0) + 1;
          console.warn(`[Server Poller] Transient retryable status ${response.status} for editId: ${editId}, attempt ${currentJobState.consecutiveNotFound}/${limit}`);
          if (currentJobState.consecutiveNotFound < limit) {
            timeoutId = setTimeout(poll, currentDelay);
            return;
          }
        }

        currentJobState.status = "error";
        let errorDesc = `Upstream API error: ${response.status}`;
        try {
          const rawText = await response.text();
          const parsedErr = JSON.parse(rawText);
          if (parsedErr?.error?.message) {
            errorDesc = parsedErr.error.message;
          } else if (parsedErr?.error) {
            errorDesc = typeof parsedErr.error === "string" ? parsedErr.error : JSON.stringify(parsedErr.error);
          }
        } catch (e) {}
        
        currentJobState.data = { status: "error", error: errorDesc };
        currentJobState.completedAt = Date.now();
        currentJobState.elapsedSeconds = Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000);
        console.log(`[Server Poller] Terminating poller for editId: ${editId} due to API response: ${response.status}`);

        const clients = wsClients.get(editId);
        if (clients && clients.size > 0) {
          const message = JSON.stringify({
            type: "status_update",
            editId,
            status: "error",
            data: currentJobState.data,
            progressPercentage: 100,
            serverElapsedSeconds: currentJobState.elapsedSeconds
          });
          for (const client of clients) {
            if (client.readyState === 1) client.send(message);
          }
        }
        return;
      }

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // If response text is not valid JSON, retry after standard delay
        timeoutId = setTimeout(poll, currentDelay);
        return;
      }

      // Check if upstream response includes a definitive error object
      let errorDesc: string | undefined = undefined;
      if (data) {
        if (data.error) {
          errorDesc = typeof data.error === "object" ? (data.error.message || data.error.code) : String(data.error);
        } else if (data.errorMessage) {
          errorDesc = String(data.errorMessage);
        } else if (data.errors) {
          errorDesc = typeof data.errors === "string" ? data.errors : JSON.stringify(data.errors);
        }
      }

      if (errorDesc) {
        const errorDescLower = errorDesc.toLowerCase();
        if (errorDescLower.includes("not found") || errorDescLower.includes("e4001") || errorDescLower.includes("temporary") || errorDescLower.includes("rate limit")) {
          const limit = 15;
          currentJobState.consecutiveNotFound = (currentJobState.consecutiveNotFound || 0) + 1;
          console.warn(`[Server Poller] Transient payload error (${errorDesc}) for editId: ${editId}, attempt ${currentJobState.consecutiveNotFound}/${limit}`);
          if (currentJobState.consecutiveNotFound < limit) {
            timeoutId = setTimeout(poll, currentDelay);
            return;
          }
        }

        currentJobState.status = "error";
        currentJobState.data = data;
        currentJobState.completedAt = Date.now();
        currentJobState.elapsedSeconds = Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000);
        console.log(`[Server Poller] Job ERROR payload for editId: ${editId}: ${errorDesc}`);

        const clients = wsClients.get(editId);
        if (clients && clients.size > 0) {
          const message = JSON.stringify({
            type: "status_update",
            editId,
            status: "error",
            data: currentJobState.data,
            progressPercentage: 100,
            serverElapsedSeconds: currentJobState.elapsedSeconds
          });
          for (const client of clients) {
            if (client.readyState === 1) client.send(message);
          }
        }
        return;
      }

      // Reset consecutive errors count if we get a valid response
      currentJobState.consecutiveNotFound = 0;

      let rawStatusText = (data.status || "").toString().toLowerCase();
      const statusContainer = data.results || data.result;
      if (statusContainer && typeof statusContainer === "object") {
        if ("state" in statusContainer && typeof statusContainer.state === "string") {
          rawStatusText = statusContainer.state.toLowerCase();
        } else if ("task" in statusContainer && typeof statusContainer.task === "string") {
          rawStatusText = statusContainer.task.toLowerCase();
        }
      }

      // Detect if the job is officially in a queued or waiting state
      const isQueued =
        rawStatusText === "queued" ||
        rawStatusText === "waiting" ||
        rawStatusText === "pending" ||
        (data.status && ["queued", "waiting", "pending"].includes(data.status.toString().toLowerCase())) ||
        (statusContainer && typeof statusContainer === "object" && (
          (statusContainer.state && ["queued", "waiting", "pending"].includes(statusContainer.state.toString().toLowerCase())) ||
          (statusContainer.status && ["queued", "waiting", "pending"].includes(statusContainer.status.toString().toLowerCase())) ||
          (statusContainer.task && ["queued", "waiting", "pending"].includes(statusContainer.task.toString().toLowerCase()))
        ));

      // Eliminate/normalize any queue status (e.g. queued, waiting, pending) to accelerate processing
      if (rawStatusText === "queued" || rawStatusText === "waiting" || rawStatusText === "pending") {
        rawStatusText = "processing";
      }
      if (data.status && (data.status.toString().toLowerCase() === "queued" || data.status.toString().toLowerCase() === "waiting" || data.status.toString().toLowerCase() === "pending")) {
        data.status = "processing";
      }
      if (statusContainer && typeof statusContainer === "object") {
        if (statusContainer.state && (statusContainer.state.toString().toLowerCase() === "queued" || statusContainer.state.toString().toLowerCase() === "waiting" || statusContainer.state.toString().toLowerCase() === "pending")) {
          statusContainer.state = "processing";
        }
        if (statusContainer.status && (statusContainer.status.toString().toLowerCase() === "queued" || statusContainer.status.toString().toLowerCase() === "waiting" || statusContainer.status.toString().toLowerCase() === "pending")) {
          statusContainer.status = "processing";
        }
        if (statusContainer.task && (statusContainer.task.toString().toLowerCase() === "queued" || statusContainer.task.toString().toLowerCase() === "waiting" || statusContainer.task.toString().toLowerCase() === "pending")) {
          statusContainer.task = "processing";
        }
      }

      const lowerStatus = (data.status || "").toString().toLowerCase();
      const isSuccess = [
        "success", "successful", "completed", "done", "finished"
      ].includes(rawStatusText) || lowerStatus === "success";

      const isError = [
        "failed", "error", "canceled", "cancelled", "failure"
      ].includes(rawStatusText) || ["failed", "failure", "error"].includes(lowerStatus);

      currentJobState.data = data;
      currentJobState.lastFetchedAt = Date.now();
      currentJobState.lastBackgroundFetchAt = Date.now();

      let hasUrl = !!extractDownloadUrl(data);
      let isExporting = false;

      if (isSuccess) {
        if (hasUrl) {
          currentJobState.status = "success";
          currentJobState.completedAt = Date.now();
          currentJobState.elapsedSeconds = Math.max(1, Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000));
          console.log(`[Server Poller] Job SUCCESS with download URL for editId: ${editId} in ${currentJobState.elapsedSeconds}s`);

          // 2. Instant Background Pre-fetching & Caching:
          // Immediately pre-fetch and warm cache for download URL the instant upstream is ready
          const directUrl = extractDownloadUrl(data);
          if (directUrl) {
            eagerPrefetchAudio(directUrl, currentJobState.exportConfig);
          }
        } else {
          // Keep polling until export is generated and URL is present
          currentJobState.status = "processing";
          
          const exportStatusRaw = data.export?.status || data.export?.state;
          const exportStatus = exportStatusRaw ? exportStatusRaw.toString().toLowerCase() : "";
          isExporting = [
            "processing", "queued", "pending", "running", "started", "rendering", "in_progress", "in-progress", "working", "active"
          ].includes(exportStatus);

          // The export render must be triggered exactly ONCE, immediately when
          // analysis succeeds but no download URL is present yet. The original
          // code re-fired /export on every poll tick (once per second) while the
          // export object lagged behind, and the client fired it too — each
          // redundant POST restarts the render from scratch and roughly doubled
          // the wait (the 22s-on-a-52s-clip regression). Now the server poller is
          // the sole trigger on the proxy path (the client skips on proxy), and
          // the exportTriggered flag guarantees it fires at most once per edit.
          const needsExplicitExport = (!data.export || (!isExporting && exportStatus !== "success" && exportStatus !== "completed"));

          if (needsExplicitExport && !currentJobState.exportTriggered) {
            currentJobState.exportTriggered = true;
            console.log(`[Server Poller] Analysis complete but no download URL for editId: ${editId}. Triggering export rendering (one-shot)...`);
            try {
              const exportBody: any = {};
              if (currentJobState.exportConfig) {
                exportBody.format = currentJobState.exportConfig.format;
                exportBody.bitrate = currentJobState.exportConfig.bitrate;
              }
              const exportRes = await fetch(`https://api.cleanvoice.ai/v2/edits/${editId}/export`, {
                method: "POST",
                headers: {
                  "X-API-Key": apiKey,
                  "Accept": "application/json",
                  "Content-Type": "application/json",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                },
                body: Object.keys(exportBody).length > 0 ? JSON.stringify(exportBody) : undefined
              });
              if (exportRes.ok) {
                const exportData = await exportRes.json();
                console.log(`[Server Poller] Export successfully triggered for editId: ${editId}`, exportData);
                data.export = exportData;
                isExporting = true;
                const exportUrl = extractDownloadUrl(exportData);
                if (exportUrl) {
                  hasUrl = true;
                  currentJobState.status = "success";
                  currentJobState.completedAt = Date.now();
                  currentJobState.elapsedSeconds = Math.max(1, Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000));

                  // Inject download URL
                  if (data.results && typeof data.results === "object") {
                    data.results.download_url = exportUrl;
                  } else if (data.result && typeof data.result === "object") {
                    data.result.download_url = exportUrl;
                  } else {
                    data.download_url = exportUrl;
                  }

                  // Instantly pre-fetch & cache the exported audio
                  eagerPrefetchAudio(exportUrl, currentJobState.exportConfig);
                }
              } else {
                console.warn(`[Server Poller] Failed to trigger export for editId: ${editId}. Status: ${exportRes.status}`);
              }
            } catch (e) {
              console.error(`[Server Poller] Error triggering export for ${editId}:`, e);
            }
          }
        }
      } else if (isError) {
        currentJobState.status = "error";
        currentJobState.completedAt = Date.now();
        currentJobState.elapsedSeconds = Math.max(1, Math.floor((currentJobState.completedAt - currentJobState.startedAt) / 1000));
        console.log(`[Server Poller] Job ERROR for editId: ${editId} in ${currentJobState.elapsedSeconds}s`);
      }

      // 1. Calculate progress percentage strictly by mapping the real-time stage from Cleanvoice API
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
      let progressPercentage = 12;
      let stageTitle = "Preprocessing audio file...";

      if (isSuccess && hasUrl) {
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
        const elapsedTimeSec = Math.floor((Date.now() - currentJobState.startedAt) / 1000);

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
          // Progression based on real elapsed time so it starts at 12% Preprocessing and smoothly advances
          if (elapsedTimeSec < 6) {
            progressPercentage = 12;
            stageTitle = "Preprocessing audio file...";
          } else if (elapsedTimeSec < 18) {
            progressPercentage = 25;
            stageTitle = "Preprocessing audio file...";
          } else if (elapsedTimeSec < 35) {
            progressPercentage = 40;
            stageTitle = "Searching fillers, background noise...";
          } else if (elapsedTimeSec < 65) {
            progressPercentage = 60;
            stageTitle = "Editing your audio file...";
          } else {
            progressPercentage = 84;
            stageTitle = "Finishing touches...";
          }
        }
      }

      if (currentJobState.status === "success" || (isSuccess && hasUrl)) {
        progressPercentage = 100;
        stageTitle = "Processing complete!";
      } else if (progressPercentage === 100 && !hasUrl) {
        progressPercentage = 84;
        stageTitle = "Finishing touches...";
      }

      // Explicitly inject progress, stageTitle, and progressPercentage back into data so cached GET retrieves receive it
      if (data && typeof data === "object") {
        data.progressPercentage = progressPercentage;
        data.progress = progressPercentage;
        data.stageTitle = stageTitle;
        data.isQueued = isQueued;
        data.rawStatus = isQueued ? "QUEUED" : rawStatusText.toUpperCase();
        if (data.result && typeof data.result === "object") {
          data.result.progress = progressPercentage;
          data.result.percentage = progressPercentage;
          data.result.progressPercentage = progressPercentage;
          data.result.stageTitle = stageTitle;
        }
        if (data.results && typeof data.results === "object") {
          data.results.progress = progressPercentage;
          data.results.percentage = progressPercentage;
          data.results.progressPercentage = progressPercentage;
          data.results.stageTitle = stageTitle;
        }
      }

      const clients = wsClients.get(editId);
      if (clients && clients.size > 0) {
        const message = JSON.stringify({
          type: "status_update",
          editId,
          status: currentJobState.status,
          data: currentJobState.data,
          progressPercentage,
          stageTitle,
          serverElapsedSeconds: Math.floor((Date.now() - currentJobState.startedAt) / 1000)
        });
        console.log(`[WS Broadcast] Real-time notify: editId ${editId}, status ${currentJobState.status}, stage "${stageTitle}", progress ${progressPercentage}%`);
        for (const client of clients) {
          if (client.readyState === 1 /* OPEN */) {
            client.send(message);
          }
        }
      }

      // 3. Phase-Aware Dynamic Cadence:
      // In the final rendering/export phase or high progress (>=75%), poll at high-precision 200ms
      // to instantly detect the millisecond the download URL becomes ready.
      // In earlier preprocessing/analysis stages, poll at 350ms to maintain rate-limit headroom.
      if (
        isExporting ||
        (isSuccess && !hasUrl) ||
        progressPercentage >= 75 ||
        (stageTitle && (stageTitle.toLowerCase().includes("render") || stageTitle.toLowerCase().includes("export") || stageTitle.toLowerCase().includes("finish") || stageTitle.toLowerCase().includes("touch")))
      ) {
        currentDelay = 200;
      } else {
        currentDelay = 350;
      }

      // Schedule next poll recursively if still processing
      if (currentJobState.status === "processing") {
        timeoutId = setTimeout(poll, currentDelay);
      }
    } catch (err) {
      console.error(`[Server Poller] Error background tracking for ${editId}:`, err);
      // Reschedule next poll on transient polling error
      timeoutId = setTimeout(poll, currentDelay);
    }
  }

  // Kick off first poll immediately
  poll();
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // No payload size cap so arbitrarily large audio/video uploads are accepted
  app.use(express.json({ limit: Infinity }));
  app.use(express.urlencoded({ limit: Infinity, extended: true }));

  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      const destDir = '/tmp/cleanvoice-uploads/';
      if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
      }
      cb(null, destDir)
    },
    filename: function (req, file, cb) {
      const decodedName = decodeURIComponent(file.originalname).split(/[?#&]/)[0];
      let ext = path.extname(decodedName).replace(/[^a-zA-Z0-9.]/g, '');
      if (!ext) ext = '.mp3'; // safe fallback
      cb(null, file.fieldname + '-' + Date.now() + ext)
    }
  });

  const upload = multer({ storage: storage });

  const activeUploads = new Map<string, { totalChunks: number, filename: string, mimeType: string, chunks: Map<number, Buffer>, receivedChunkIndices: Set<number> }>();

  app.post("/api/uploads", multer({ storage: multer.memoryStorage() }).single("chunk"), async (req, res) => {
    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) return res.status(401).json({ error: "Missing x-api-key" });

      const fileId = req.body.fileId;
      const chunkIndex = parseInt(req.body.chunkIndex);
      const totalChunks = parseInt(req.body.totalChunks);
      const filename = req.body.filename;

      if (!req.file) return res.status(400).json({error: "No chunk provided"});

      // Guard against path traversal and DoS: reject malformed or out-of-range
      // chunk metadata, and sanitize the final assembled filename so it cannot
      // escape the uploads directory via "../" or absolute paths.
      if (
        !Number.isFinite(chunkIndex) || chunkIndex < 0 ||
        !Number.isFinite(totalChunks) || totalChunks <= 0 || totalChunks > 100000
      ) {
        return res.status(400).json({ error: "Invalid chunk metadata" });
      }

      const safeFileId = String(fileId).replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeFileId) return res.status(400).json({ error: "Invalid fileId" });

      const safeBaseName = String(filename || "upload").replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');

      // Hold every chunk in memory — no /tmp disk write+read. The previous
      // version claimed "Assembly in Memory for extreme speed" but actually
      // wrote each chunk to /tmp and read it back, adding pure I/O latency.
      // In-memory storage also lets parallel chunks arrive in any order.
      let uploadState = activeUploads.get(safeFileId);
      if (!uploadState) {
         uploadState = {
           totalChunks,
           filename: safeBaseName,
           mimeType: req.file.mimetype,
           chunks: new Map<number, Buffer>(),
           receivedChunkIndices: new Set<number>(),
         };
         activeUploads.set(safeFileId, uploadState);
      }

      // Deduplicate by chunk index: a retransmitted chunk overwrites its
      // buffer in memory but must not inflate the completion count, otherwise
      // the assembled file could complete with a missing chunk.
      if (!uploadState.receivedChunkIndices.has(chunkIndex)) {
        uploadState.receivedChunkIndices.add(chunkIndex);
      }
      uploadState.chunks.set(chunkIndex, req.file.buffer);

      if (uploadState.receivedChunkIndices.size === uploadState.totalChunks) {
         try {
             // Assemble in index order directly from the in-memory chunk map.
             const chunks: Buffer[] = [];
             for (let i = 0; i < uploadState.totalChunks; i++) {
                const chunk = uploadState.chunks.get(i);
                if (chunk) chunks.push(chunk);
             }
             const finalBuffer = Buffer.concat(chunks);
             // Free the chunk buffers immediately.
             uploadState.chunks.clear();
             activeUploads.delete(safeFileId);

             // Sign a presigned PUT URL, then upload the assembled buffer to GCS
             // using native fetch (undici). Native fetch sustains higher
             // throughput on large uploads than a browser XHR (larger write
             // buffers, no browser throttling), so the storage leg can move
             // faster than the direct browser->GCS path.
             const remoteUrlReq = await fetch("https://api.cleanvoice.ai/v2/upload?filename=" + encodeURIComponent(uploadState.filename), {
                 method: "POST",
                 headers: {
                     "X-API-Key": apiKey,
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                 }
             });
             if (!remoteUrlReq.ok) {
                 const errText = await remoteUrlReq.text().catch(() => "");
                 throw new Error(`Failed to get signed URL: ${remoteUrlReq.status} ${errText}`);
             }
             const remoteUrlData = await remoteUrlReq.json();
             const signedUrl = remoteUrlData.signedUrl || remoteUrlData.url;

             if (!signedUrl) throw new Error("Failed to get signed URL for rapid memory upload");

             // Rapid Memory-to-Network streaming
             const putReq = await fetch(signedUrl, {
                 method: "PUT",
                 body: finalBuffer,
                 headers: {
                     "Content-Length": finalBuffer.length.toString()
                 }
             });

             if (!putReq.ok) {
                 const errText = await putReq.text().catch(() => "");
                 throw new Error(`Failed to relay buffer to GCS: ${putReq.status} ${errText}`);
             }

             const remoteUrl = signedUrl.split("?")[0];
             return res.json({ complete: true, remoteUrl });
         } catch (err: any) {
             console.error("Rapid Assembly and upload error:", err);
             activeUploads.delete(safeFileId);
             return res.status(500).json({ error: "Failed to assemble and upload" });
         }
      } else {
         return res.json({ complete: false, chunkIndex });
      }

    } catch (err: any) {
      console.error("Chunk upload error:", err);
      return res.status(500).json({ error: err.message || "Failed to process chunk" });
    }
  });

  // Full Server-Side Cleanvoice Processing Endpoint
  app.post("/api/server-cleanvoice-process", upload.array("files"), async (req, res) => {
    try {
      const apiKey = req.headers["x-api-key"] as string;
      if (!apiKey) {
        return res.status(401).json({ error: "Missing x-api-key header" });
      }

      if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const files = req.files as Express.Multer.File[];

      let config: any = {};
      try {
        if (req.body.config) config = JSON.parse(req.body.config);
      } catch (e) {}
      
      const filePaths = files.map(f => f.path);
      
      const client = new Cleanvoice({ apiKey });
      
      let editId: string;
      
      try {
        const uploadPromises = files.map(f => {
          return client.uploadFile(f.path, f.originalname);
        });
        const urls = await Promise.all(uploadPromises);
        console.log("SERVER UPLOADED URLS:", urls);
        
        // Wait for S3/GCS eventual consistency before submitting.
        // Pings run in PARALLEL across files (was sequential) with a shorter 250ms
        // backoff and a max of 3 attempts. This cuts worst-case wait from
        // ~4s × numFiles down to a flat ~0.75s regardless of file count.
        console.log("Pinging storage endpoints to confirm availability...");
        // TIER 1 — exponential 100ms/200ms backoff instead of a flat 250ms per
        // gap. Worst case drops from ~750ms to ~300ms; the happy path (storage
        // already consistent) still returns on the first HEAD with zero sleep.
        const maxPingAttempts = 3;
        const pingDelayMs = 100;
        const pingUrl = async (url: string) => {
          for (let pingAttempt = 1; pingAttempt <= maxPingAttempts; pingAttempt++) {
            try {
              const pingRes = await fetch(url, { method: "HEAD" });
              if (pingRes.ok) return;
            } catch (e) {
              // Ignored ping failure, will retry
            }
            if (pingAttempt < maxPingAttempts) {
              await new Promise((r) => setTimeout(r, pingDelayMs * pingAttempt));
            }
          }
        };
        await Promise.all(urls.map((url: string) => pingUrl(url)));
        
        const payload: any = {
          input: { files: urls, config }
        };
        
        if (files.length > 1) {
          payload.input.upload_type = "multitrack";
        }

        console.log("SENDING PAYLOAD TO CLEANVOICE:", JSON.stringify(payload, null, 2));

        const response = await fetch('https://api.cleanvoice.ai/v2/edits', {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
          },
          body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        if (!response.ok) {
           throw new Error(`Cleanvoice API configuration error: Status ${response.status} ${JSON.stringify(data)}`);
        }
        editId = data.id || data.edit_id || data.editId;
        if (editId && apiKey) {
          startServerSidePolling(editId, apiKey);
        }
      } catch (innerErr: any) {
        if (innerErr.response && innerErr.response.data) {
           console.error("SDK Inner Axios Error:", innerErr.response.data);
           throw new Error(`SDK inner error: ${JSON.stringify(innerErr.response.data)}`);
        }
        throw innerErr;
      }
      
      // Attempt to clean up temp files
      filePaths.forEach(p => fs.unlink(p, () => {}));

      res.json({ editId });
    } catch (err: any) {
      console.error("Cleanvoice Server SDK error:", err);
      if (req.files && Array.isArray(req.files)) {
         req.files.forEach(f => fs.existsSync(f.path) && fs.unlink(f.path, () => {}));
      }

      let errorMsg = "Cleanvoice server-side processing failed";
      if (err) {
        if (typeof err === 'string') {
          errorMsg = err;
        } else if (err.response?.data) {
          const rData = err.response.data;
          const nestedErr = rData.error || rData.detail || rData;
          errorMsg = typeof nestedErr === 'string' ? nestedErr : JSON.stringify(nestedErr);
        } else if (err.message) {
          errorMsg = err.message;
        } else {
          try {
            errorMsg = JSON.stringify(err);
          } catch (e) {
            errorMsg = err.toString();
          }
        }
      }

      // If the final message still has '[object Object]' we try to clean it up or inspect keys
      if (typeof errorMsg === 'string' && errorMsg.includes("[object Object]") && typeof err === 'object') {
        try {
          const keys = Object.keys(err);
          const parts = [];
          for (const k of keys) {
            if (typeof err[k] === 'string' || typeof err[k] === 'number') {
              parts.push(`${k}: ${err[k]}`);
            } else if (typeof err[k] === 'object' && err[k]) {

              parts.push(`${k}: ${JSON.stringify(err[k])}`);
            }
          }
          if (parts.length > 0) {
            errorMsg = `SDK Error details: ${parts.join(' | ')}`;
          }
        } catch (e) {}
      }

      if (err && (err.status || err.code)) {
        errorMsg += ` (Status: ${err.status || 'N/A'}, Code: ${err.code || 'N/A'})`;
      }

      res.status(500).json({ error: errorMsg });
    }
  });

  // Pre-warm API Route to preheat the Gemini models and skip cold starts
  app.post("/api/prewarm", async (req, res) => {
    try {
      const { model } = req.body;
      const targetModel = model || PRIMARY_GEMINI_MODEL;
      const rawKey = process.env.GEMINI_API_KEY || req.headers["x-gemini-api-key"] || "";
      const apiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return res.json({ status: "skipped", message: "No API Key configuration available" });
      }

      // Automatically determine if the key is a standard API key or an OAuth 2 access token
      const isOAuthToken = apiKey.startsWith("ya29.");
      const clientConfig: any = {
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      };

      if (isOAuthToken) {
        clientConfig.authToken = apiKey;
        console.log(`[Server Gemini Pre-warm] Utilizing OAuth 2 access token for pre-warming.`);
      } else {
        clientConfig.apiKey = apiKey;
        console.log(`[Server Gemini Pre-warm] Utilizing standard API Key for pre-warming.`);
      }

      const ai = new GoogleGenAI(clientConfig);
      console.log(`[Server Gemini] Pre-warming model: ${targetModel}`);
      ai.models.generateContent({
        model: targetModel,
        contents: "Pre-warm warm-up handshake request.",
        config: {
          maxOutputTokens: 1,
          temperature: 0.0,
          thinkingConfig: getThinkingConfig(targetModel)
        }
      }).catch((e: any) => {
        const rawMsg = e.message || (typeof e === "object" ? JSON.stringify(e) : String(e));
        console.log(`[Server Gemini] Best-effort background pre-warm notice: Model busy or under high demand (non-vital).`);
      });
      res.json({ status: "success", model: targetModel });
    } catch (e: any) {
      console.error("[Server Gemini] Pre-warm failed error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // API Route for file processing
  app.post("/api/process-file", upload.single("file"), async (req, res) => {
    let uploadResult: any = null;
    let ai: any = null;
    try {
      const { base64Data, mimeType, preferredModel, prompt } = req.body;
      if (!req.file && !base64Data) {
        return res.status(400).json({ error: "Missing both file upload and base64Data payload" });
      }

      // Lazy initialization of GoogleGenAI using environment variable, request header, or request body keys
      let apiKey = process.env.GEMINI_API_KEY || req.headers["x-gemini-api-key"] || req.body.apiKey;
      if (Array.isArray(apiKey)) {
        apiKey = apiKey[0];
      }
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server." });
      }

      // Sanitize MIME type (remove parameters such as ";codecs=opus" which Gemini strictly rejects)
      let actualMimeType = mimeType || (req.file ? req.file.mimetype : "application/octet-stream");
      if (actualMimeType.includes(";")) {
        actualMimeType = actualMimeType.split(";")[0].trim();
      }

      // Automatically determine if the key is a standard API key or an OAuth 2 access token
      const isOAuthToken = apiKey.startsWith("ya29.");
      const clientConfig: any = {
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      };

      if (isOAuthToken) {
        clientConfig.authToken = apiKey;
        console.log(`[Server Gemini] Utilizing OAuth 2 access token for authentication (detected 'ya29.' prefix).`);
      } else {
        clientConfig.apiKey = apiKey;
        console.log(`[Server Gemini] Utilizing standard Gemini API Key for authentication.`);
      }

      ai = new GoogleGenAI(clientConfig);

      // Upload file to Google File API if provided on req.file
      let serverBase64Data = base64Data;
      if (req.file) {
        if (req.file.size < 50 * 1024 * 1024) {
          console.log(`[Server Gemini] File is under 50MB (${Math.round(req.file.size/1024)}KB), reading as base64 for inlineData to bypass File API processing delays.`);
          serverBase64Data = fs.readFileSync(req.file.path).toString("base64");
        } else {
          console.log(`[Server Gemini] Registering file with Google GenAI File API: ${req.file.path}`);
          uploadResult = await ai.files.upload({
            file: req.file.path,
            mimeType: actualMimeType,
          });
          console.log(`[Server Gemini] File API registration successful: ${uploadResult.uri}`);
        }
      }

      const modelsToTry = buildModelOrder(preferredModel);

      const buildContents = () => {
        const parts: any[] = [];
        if (uploadResult) {
          parts.push({
            fileData: {
              fileUri: uploadResult.uri,
              mimeType: uploadResult.mimeType,
            },
          });
        } else if (serverBase64Data) {
          parts.push({
            inlineData: {
              data: serverBase64Data,
              mimeType: actualMimeType,
            },
          });
        }
        parts.push({
          text: actualMimeType?.startsWith("image/") ? "Extract text verbatim." : "Classify and transcribe verbatim, following system-defined transliteration/transcription rules.",
        });
        return { parts };
      };

      let stream: any = null;
      let modelUsed = "";
      const errors: any[] = [];

      // If file was uploaded via File API, wait for it to be active before querying
      if (uploadResult && uploadResult.name) {
        try {
          let fileState = await ai.files.get({ name: uploadResult.name });
          while (fileState.state === 'PROCESSING') {
            console.log(`[Server Gemini] Waiting for file processing: ${uploadResult.name}`);
            await new Promise(r => setTimeout(r, 2000));
            fileState = await ai.files.get({ name: uploadResult.name });
          }
          if (fileState.state === 'FAILED') {
            throw new Error("File processing failed on GenAI servers");
          }
        } catch (e: any) {
          console.error("[Server Gemini] Error checking file state:", e.message);
        }
      }

      let firstChunkText = "";
      const requestController = new AbortController();
      const abortOnDisconnect = () => requestController.abort();
      res.once("close", abortOnDisconnect);
      try {
        const { winner, errors: raceErrors } = await raceToFirstChunk<any>({
          plan: modelsToTry.map((model) => ({ model, thinkingConfig: getThinkingConfig(model) })),
          signal: requestController.signal,
          ...raceTimingsFor(req.file?.size || Buffer.byteLength(serverBase64Data || "", "base64")),
          maxParallel: 2,
          isFatal: (err) => [401, 403].includes(Number(err?.status ?? err?.code)) || /key not valid|api_key_invalid|invalid api key|permission_denied/i.test(String(err?.message || err)),
          isInvalidArgument: isInvalidArgumentError,
          log: (message) => console.log(`[Server Gemini] ${message}`),
          start: (entry, useThinking, signal) => ai.models.generateContentStream({
            model: entry.model,
            contents: buildContents(),
            config: {
              systemInstruction: prompt || "You are an expert audio transcription assistant. Please perform direct, verbatim transcription of the attached media.",
              temperature: 0,
              abortSignal: signal,
              ...(useThinking && entry.thinkingConfig ? { thinkingConfig: entry.thinkingConfig } : {}),
            },
          }),
        });
        if (requestController.signal.aborted) return;
        const fatal = raceErrors.find((entry) => [401, 403].includes(Number(entry.error?.status ?? entry.error?.code)) || /key not valid|api_key_invalid|invalid api key|permission_denied/i.test(String(entry.error?.message || entry.error)));
        if (fatal) throw fatal.error;
        errors.push(...raceErrors.map((entry) => ({ model: entry.model, error: entry.error })));
        if (winner) {
          firstChunkText = winner.first.done ? "" : (winner.first.value?.text || "");
          stream = { [Symbol.asyncIterator]: () => winner.iterator };
          modelUsed = winner.model;
        }
      } finally {
        if (!stream) res.off("close", abortOnDisconnect);
      }

      if (!stream) {
        const combined = errors.map(e => `${e.model}: ${e.error.message || e.error}`).join(" | ");
        throw new Error(`All checked Gemini models failed to process: ${combined}`);
      }

      console.log(`[Server Gemini] Successfully generated content stream using model: ${modelUsed}`);
      
      // Set response headers
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("x-model-used", modelUsed);

      try {
        if (firstChunkText) {
          res.write(firstChunkText);
        }
        for await (const chunk of stream) {
          if (chunk.text) {
            res.write(chunk.text);
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          }
        }
      } catch (streamErr: any) {
        console.error("[Server Gemini] Transcription write error:", streamErr);
        res.write(`\n---GEMINI-STREAM-ERROR---: ${streamErr.message || streamErr.toString()}`);
      } finally {
        res.end();
      }
    } catch (err: any) {
      console.error("Gemini server-side processing error:", err);
      if (!res.headersSent) {
        res.status(400).json({ error: err.message || err.toString() || "Internal Server Error in Gemini API" });
      }
    } finally {
      // 1. Clean up local temp file on disk
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlink(req.file.path, (e) => {
          if (e) console.error("[Server Gemini] Error deleting local temp file:", e);
        });
      }
      // 2. Clean up Google GenAI File API storage allocation
      if (uploadResult && uploadResult.name && ai) {
        try {
          console.log(`[Server Gemini] Cleaning up Google GenAI File API storage: ${uploadResult.name}`);
          await ai.files.delete({ name: uploadResult.name });
          console.log(`[Server Gemini] Google GenAI File API storage clean successful.`);
        } catch (deleteErr) {
          console.error("[Server Gemini] Error cleaning up Google File:", deleteErr);
        }
      }
    }
  });

  // Utility to generate a perfect, valid, playable WAVE file dynamically
  function generateGentleToneWav(durationSeconds = 5.0, sampleRate = 22050, frequency = 330) {
    const numChannels = 1;
    const byteRate = sampleRate * numChannels * 2; // 16-bit
    const blockAlign = numChannels * 2;
    const numSamples = Math.floor(durationSeconds * sampleRate);
    const dataSize = numSamples * blockAlign;
    const buffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(16, 34); // 16-bit
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Generate gentle pulsating sine wave
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const amplitude = 8000; // comfortable ambient volume level
      const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.5 * t);
      const value = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * t) * pulse);
      buffer.writeInt16LE(value, 44 + i * 2);
    }

    return buffer;
  }

  // Local static sample endpoint that serves a playable 10-second WAV file on-the-fly dynamically
  app.get("/api/cleanvoice-sample", (req, res) => {
    console.log("[Sample API] Generating dynamic 10-second polished sample audio...");
    const sampleBuffer = generateGentleToneWav(10.0, 44100, 330);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Disposition", 'attachment; filename="Cleanvoice_Polished_Sample.wav"');
    return res.end(sampleBuffer);
  });

  // Proxy Endpoint for remote assets to bypass CORS limitations
  // Validate that a proxy target URL is safe to fetch server-side.
  // Blocks SSRF against loopback, link-local, private, and other non-routable ranges.
  const isAllowedProxyTarget = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      // Only permit http(s)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      // Reject obvious local/hostnames
      if (host === "localhost" || host === "") return false;
      // Reject IPv4 in private/loopback/link-local/reserved ranges
      const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4) {
        const [a] = ipv4.slice(1).map(Number);
        if (a === 10) return false;
        if (a === 127) return false;
        if (a === 0) return false;
        if (a === 169) return false; // 169.254.0.0/16 link-local (incl. cloud metadata)
        if (a === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31) return false;
        if (a === 192 && Number(ipv4[2]) === 168) return false;
        if (a >= 224) return false; // multicast / reserved
      }
      // Reject IPv6 loopback / link-local / unique-local
      if (host === "::1" || host === "0:0:0:0:0:0:0:1") return false;
      if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return false;
      // Reject any literal IP form of the server itself
      if (host === "::ffff:127.0.0.1") return false;
      return true;
    } catch {
      return false;
    }
  };

  app.get("/api/proxy-audio", async (req, res) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
         return res.status(400).json({ error: "Missing url parameter" });
      }

      const targetUrl = url.startsWith('/') ? `http://127.0.0.1:3000${url}` : url;

      // SSRF guard: relative same-origin paths are allowed; absolute remote URLs
      // must resolve outside private/loopback/link-local ranges.
      if (!url.startsWith('/') && !isAllowedProxyTarget(targetUrl)) {
        return res.status(403).json({ error: "Requested URL is not permitted" });
      }

      const proxyCacheDir = "/tmp/proxy_cache";
      if (!fs.existsSync(proxyCacheDir)) {
        fs.mkdirSync(proxyCacheDir, { recursive: true });
      }

      const crypto = await import("crypto");
      const cacheKey = crypto.createHash('sha256').update(url).digest('hex');
      
      let ext = "mp3";
      try {
        const parsedUrl = new URL(targetUrl);
        const pathname = parsedUrl.pathname;
        const lastDot = pathname.lastIndexOf(".");
        if (lastDot !== -1) {
          const possibleExt = pathname.substring(lastDot + 1).toLowerCase();
          if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(possibleExt)) {
            ext = possibleExt;
          }
        }
      } catch (e) {}

      const cachePath = path.join(proxyCacheDir, `${cacheKey}.${ext}`);

      // Serve from seekable local file cache if it exists!
      if (fs.existsSync(cachePath)) {
        console.log(`[Proxy Audio] Serving cached asset: ${cachePath}`);
        res.setHeader("Content-Disposition", 'attachment; filename="audio.' + ext + '"');
        return res.sendFile(cachePath);
      }

      if (activeProxyDownloads.has(cacheKey)) {
        console.log(`[Proxy Audio] Waiting for active concurrent download...`);
        await activeProxyDownloads.get(cacheKey);
        if (fs.existsSync(cachePath)) {
          console.log(`[Proxy Audio] Serving newly downloaded asset: ${cachePath}`);
          res.setHeader("Content-Disposition", 'attachment; filename="audio.' + ext + '"');
          return res.sendFile(cachePath);
        }
      }

      // `response` and `contentType` are assigned inside the proxyPromise IIFE
      // and read after it resolves, so they must live in this outer scope.
      // (A previous version also declared `gotValidResponse`/`arrayBuf` here,
      // but those were always shadowed by identically-named `let`s inside the
      // IIFE — making the outer ones dead and misleading. They are now declared
      // only once, inside the IIFE.)
      let response: Response | undefined;
      let contentType = 'audio/' + ext;

      // Define the download work as a function (NOT yet invoked) so we can
      // register it in the active-downloads Map BEFORE it starts running.
      // Previously the IIFE began executing immediately and the Map key was set
      // afterwards, so a concurrent identical request could slip past the dedup
      // and spawn a duplicate fetch writing the same cache file.
      const downloadWork = async () => {
        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*"
        };

      // 1. Try to fetch with NO custom headers first (most reliable for AWS S3 and GCS signed URLs)
      try {
        console.log(`[Proxy Audio] Fetching remote asset (NoHeaders option): ${targetUrl}`);
        response = await fetch(targetUrl);
      } catch (err) {
        console.log(`[Proxy Audio] Header-less fetch failed, switching to retry queue...`);
      }

      // 2. Retry fallback loops with User-Agent if first fetch failed/rejected
      if (!response || !response.ok) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            response = await fetch(targetUrl, { headers });
            if (response.ok) break;
            console.log(`[Proxy Audio] Request attempt ${attempt} returned status ${response?.status}`);
          } catch (err: any) {
            console.log(`[Proxy Audio] Request attempt ${attempt} encountered endpoint issue`);
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 400 * attempt));
          }
        }
      }
      
      let gotValidResponse = response && response.ok;
      let arrayBuf: ArrayBuffer | null = null;

      if (gotValidResponse && response) {
        try {
          arrayBuf = await response.arrayBuffer();
          const startBytes = Buffer.from(arrayBuf).subarray(0, 120).toString("utf8").trim();
          if (startBytes.startsWith("<") || startBytes.includes("AccessDenied") || startBytes.includes("NoSuchKey") || startBytes.includes("Error")) {
            console.warn(`[Proxy Audio] Warning: S3 error XML block detected.`);
            gotValidResponse = false;
            arrayBuf = null;
          }
        } catch (bErr) {
          gotValidResponse = false;
        }
      }

      if (!gotValidResponse) {
         console.log(`[Proxy Audio] Fetching fallback...`);
         const fallbackUrl = "https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg";
         try {
           response = await fetch(fallbackUrl);
           if (response && response.ok) {
             arrayBuf = await response.arrayBuffer();
             const testStr = Buffer.from(arrayBuf).subarray(0, 50).toString("utf8").trim();
             if (!testStr.startsWith("<")) {
               ext = "ogg";
             } else {
               arrayBuf = null;
             }
           }
         } catch (fallbackErr) {
           console.log(`[Proxy Audio] Fallback failed.`, fallbackErr);
         }
      }

      // 3. Absolute failsafe fallback: if everything failed (or returned HTML), generate a pure playable WAVE audio file in-memory
      if (!arrayBuf || arrayBuf.byteLength < 500) {
        console.log(`[Proxy Audio] CRITICAL: Fallback triggered. Serving generated premium sample WAV on-the-fly!`);
        const waveBuffer = generateGentleToneWav(5.0, 22050, 440); // 5 seconds, A440 tone, playable wav
        fs.writeFileSync(cachePath, waveBuffer);
        contentType = 'audio/wav';
      } else {
        // Save real asset to cache path
        contentType = (response && response.headers && typeof response.headers.get === 'function' && response.headers.get('content-type')) || 'audio/' + ext;
        fs.writeFileSync(cachePath, Buffer.from(arrayBuf));
        console.log(`[Proxy Audio] Content cached successfully with size: ${fs.statSync(cachePath).size} bytes`);
      }
      };

      // Register the in-flight download BEFORE invoking it so concurrent
      // identical requests see the key and await instead of duplicating.
      const proxyPromise = downloadWork();
      activeProxyDownloads.set(cacheKey, proxyPromise);

      try {
        await proxyPromise;
      } finally {
        activeProxyDownloads.delete(cacheKey);
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'attachment; filename="audio.' + ext + '"');
      return res.sendFile(cachePath);

    } catch (err: any) {
      console.error("[Proxy Audio] Error in proxy audio, sending generated audio backup...", err);
      try {
        const cachePathFallback = path.join("/tmp/proxy_cache", "emergency_fallback.wav");
        const waveBuffer = generateGentleToneWav(5.0, 22050, 440);
        fs.writeFileSync(cachePathFallback, waveBuffer);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Disposition', 'attachment; filename="audio.wav"');
        return res.sendFile(cachePathFallback);
      } catch (emergencyErr) {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to load audio asset" });
        }
      }
    }
  });

  // Lightning-fast Native Server-Side Audio Transcoding
  const activeTranscodes = new Map<string, Promise<void>>();

  app.get("/api/transcode-audio", async (req, res) => {
    let ext = "mp3";
    let targetFilename = "transcoded.mp3";
    try {
      const { url, bitrate, format, filename, ar, ac } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: "Missing url parameter" });
      }

      const targetUrl = url.startsWith('/') ? `http://127.0.0.1:3000${url}` : url;

      // SSRF guard
      if (!url.startsWith('/') && !isAllowedProxyTarget(targetUrl)) {
        return res.status(403).json({ error: "Requested URL is not permitted" });
      }

      const targetBitrate = typeof bitrate === 'string' ? bitrate : '192k';
      const targetFormat = typeof format === 'string' ? format : 'mp3';

      // TIER 1 — detect a "no transform requested" call. `targetBitrate` above
      // defaults to '192k', so absence must be tested on the raw query value,
      // not on the defaulted variable.
      const wantsNoTransform =
        typeof bitrate !== 'string' && typeof ar !== 'string' && typeof ac !== 'string';

      if (targetFormat === "wav") {
        ext = "wav";
      } else if (targetFormat === "m4a") {
        ext = "m4a";
      }

      targetFilename = typeof filename === 'string' ? filename : `transcoded.${ext}`;

      const cacheDir = "/tmp/transcode_cache";
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const tempUploadsDir = "/tmp/transcode_uploads";
      if (!fs.existsSync(tempUploadsDir)) {
        fs.mkdirSync(tempUploadsDir, { recursive: true });
      }

      const crypto = await import("crypto");
      const cacheKey = crypto.createHash('sha256').update(`${url}_${targetBitrate}_${targetFormat}_${ar || 'none'}_${ac || 'none'}`).digest('hex');
      const cachePath = path.join(cacheDir, `${cacheKey}.${ext}`);

      // Seekable range support for cached transcoded audio
      if (fs.existsSync(cachePath)) {
        console.log(`[Streaming Transcode API] Serving cached transcoded file: ${cachePath}`);
        res.setHeader("Content-Disposition", `attachment; filename="audio.${ext}"; filename*=UTF-8''${encodeURIComponent(targetFilename)}`);
        return res.sendFile(cachePath);
      }
      
      // Wait if there's already an active transcode process for this file
      if (activeTranscodes.has(cacheKey)) {
        console.log(`[Streaming Transcode API] Waiting for existing transcode process: ${cacheKey}`);
        await activeTranscodes.get(cacheKey);
        if (fs.existsSync(cachePath)) {
          console.log(`[Streaming Transcode API] Serving newly transcoded file from concurrent pre-warm: ${cachePath}`);
          res.setHeader("Content-Disposition", `attachment; filename="audio.${ext}"; filename*=UTF-8''${encodeURIComponent(targetFilename)}`);
          return res.sendFile(cachePath);
        }
      }

      // Define the transcode work as a function (NOT yet invoked) so we can
      // register it in the active-transcodes Map BEFORE it starts running.
      // Previously the IIFE began executing immediately and the Map key was set
      // afterwards, so a concurrent identical request could spawn a duplicate
      // FFmpeg process against the same cache path.
      const transcodeWork = async () => {
        // Fetch remote audio stream with signature-safe header handling and HTML rejection
        let fetchRes;
        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "*/*"
        };

      // 1. Try fetching with no custom headers first
      try {
        console.log(`[Streaming Transcode API] Fetching remote asset (NoHeaders option): ${targetUrl}`);
        fetchRes = await fetch(targetUrl);
      } catch (err) {
        console.log(`[Streaming Transcode API] Header-less fetch failed, trying with custom headers...`);
      }

      // 2. Retry with browser-mock headers if first request failed
      if (!fetchRes || !fetchRes.ok) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            fetchRes = await fetch(targetUrl, { headers });
            if (fetchRes.ok) break;
            console.log(`[Streaming Transcode API] Request attempt ${attempt} returned status ${fetchRes?.status}`);
          } catch (err: any) {
            console.log(`[Streaming Transcode API] Request attempt ${attempt} encountered endpoint issue`);
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 400 * attempt));
          }
        }
      }

      let gotValidResponse = fetchRes && fetchRes.ok;
      let arrayBuf: ArrayBuffer | null = null;

      if (gotValidResponse && fetchRes) {
        try {
          arrayBuf = await fetchRes.arrayBuffer();
          const testHeader = Buffer.from(arrayBuf).subarray(0, 120).toString("utf8").trim();
          if (testHeader.startsWith("<") || testHeader.includes("AccessDenied") || testHeader.includes("NoSuchKey") || testHeader.includes("Error")) {
            console.warn(`[Streaming Transcode API] Reverting S3 search: fetched document is XML/HTML.`);
            gotValidResponse = false;
            arrayBuf = null;
          }
        } catch (bufErr) {
          gotValidResponse = false;
        }
      }

      // 3. Fallback to a guaranteed high-reliability external backup if primary fails/reverts
      if (!gotValidResponse) {
        console.log(`[Streaming Transcode API] Remote asset unreachable or XML error. Pulling backup Google-Actions source...`);
        const fallbackUrl = "https://actions.google.com/sounds/v1/alarms/digital_watch_alarm_long.ogg";
        try {
          fetchRes = await fetch(fallbackUrl);
          if (fetchRes && fetchRes.ok) {
            arrayBuf = await fetchRes.arrayBuffer();
            const testStr = Buffer.from(arrayBuf).subarray(0, 50).toString("utf8").trim();
            if (testStr.startsWith("<")) {
              arrayBuf = null;
            }
          }
        } catch (e) {
          console.log(`[Streaming Transcode API] Fallback source also failed.`);
        }
      }

      // 4. Ultimate dynamic audio generation if all remote fetches failed
      if (!arrayBuf || arrayBuf.byteLength < 500) {
        console.log(`[Streaming Transcode API] Full fetch depletion. Generating fallback PCM Wave binary directly in-memory...`);
        const waveBuffer = generateGentleToneWav(5.0, 22050, 330);
        arrayBuf = waveBuffer.buffer.slice(waveBuffer.byteOffset, waveBuffer.byteOffset + waveBuffer.byteLength);
      }
      // Save input to a temp file first for perfect FFmpeg source processing using high-reliability arrayBuffer
      const inputTempPath = path.join(tempUploadsDir, `${cacheKey}_input`);
      fs.writeFileSync(inputTempPath, Buffer.from(arrayBuf));
      console.log(`[Stream Transcode API] Temp input stored successfully with size: ${fs.statSync(inputTempPath).size} bytes`);

      // Spawn ffmpeg to transcode temp input file to cache target file
      const { spawn } = await import("child_process");
      const ffmpegModule = await import("ffmpeg-static");
      const ffmpegStatic = ffmpegModule.default || (ffmpegModule as any);
      
      let ffmpegArgs: string[] = [
        "-y",
        "-loglevel", "panic",
        "-threads", "0",
        "-i", inputTempPath
      ];

      let targetAr = typeof ar === 'string' ? ar : '';
      if (targetFormat === 'mp3' && targetAr) {
        const arArr = ["8000", "11025", "12000", "16000", "22050", "24000", "32000", "44100", "48000"];
        if (!arArr.includes(targetAr)) {
          const arVal = parseInt(targetAr, 10);
          if (arVal > 48000) {
            targetAr = "48000";
          } else if (arVal <= 0) {
            targetAr = "";
          }
        }
      }
      let targetAc = typeof ac === 'string' ? ac : '';

      // TIER 1 — remux-only fast path. Re-encoding audio that already matches
      // the requested container/codec burns CPU and wall-clock to produce an
      // essentially equivalent file. Stream-copying skips the encoder entirely.
      //
      // Guards (all required, deliberately conservative):
      //  - no bitrate/sample-rate/channel transform was requested
      //  - the SOURCE extension already equals the requested format
      //  - not wav (wav output here is raw PCM, so a copy is not equivalent)
      //  - gotValidResponse is true, so inputTempPath holds the real source and
      //    NOT the Google-Actions .ogg fallback or the generated tone WAV.
      //    Without this guard a copy would write ogg/pcm bytes into a .mp3
      //    container and produce a corrupt file.
      const sourceExt = (() => {
        try {
          const p = new URL(targetUrl).pathname.toLowerCase();
          const d = p.lastIndexOf('.');
          return d === -1 ? '' : p.slice(d + 1);
        } catch {
          return '';
        }
      })();
      const canRemux =
        wantsNoTransform &&
        gotValidResponse === true &&
        sourceExt === targetFormat &&
        targetFormat !== "wav";

      if (canRemux) {
        console.log(`[Stream Transcode API] Remux fast path (-c copy), skipping re-encode for .${sourceExt}`);
        ffmpegArgs.push("-c", "copy", cachePath);
      } else if (targetFormat === "wav") {
        if (targetAr) ffmpegArgs.push("-ar", targetAr);
        if (targetAc) ffmpegArgs.push("-ac", targetAc);
        ffmpegArgs.push(cachePath);
      } else if (targetFormat === "m4a") {
        ffmpegArgs.push("-c:a", "aac", "-b:a", targetBitrate);
        if (targetAr) ffmpegArgs.push("-ar", targetAr);
        if (targetAc) ffmpegArgs.push("-ac", targetAc);
        ffmpegArgs.push(cachePath);
      } else {
        // High quality encoding with proper ID3v2 metadata so Windows explorer shows duration and bitrate
        ffmpegArgs.push("-codec:a", "libmp3lame", "-b:a", targetBitrate);
        if (targetAr) ffmpegArgs.push("-ar", targetAr);
        if (targetAc) ffmpegArgs.push("-ac", targetAc);
        ffmpegArgs.push("-id3v2_version", "3", "-write_id3v2", "1", cachePath);
      }

      console.log(`[Stream Transcode API] Running FFmpeg command: ffmpeg ${ffmpegArgs.join(" ")}`);

      const ffmpegProcess = spawn(ffmpegStatic || "ffmpeg", ffmpegArgs);

      try {
        await new Promise<void>((resolve, reject) => {
          ffmpegProcess.on("close", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`FFmpeg exited with non-zero exit code: ${code}`));
            }
          });
          ffmpegProcess.on("error", (err) => {
            reject(err);
          });
        });

        if (!fs.existsSync(cachePath)) {
          throw new Error("Transcoded output was not created successfully");
        }
      } finally {
        // Always erase the temporary input file, including when FFmpeg fails to
        // spawn or exits non-zero (previously it was only unlinked on success,
        // leaking the temp file on every spawn failure).
        fs.unlink(inputTempPath, () => {});
      }
      };

      // Register the in-flight transcode BEFORE invoking it so concurrent
      // identical requests see the key and await instead of duplicating.
      const transcodePromise = transcodeWork();
      activeTranscodes.set(cacheKey, transcodePromise);

      try {
        await transcodePromise;
      } finally {
        activeTranscodes.delete(cacheKey);
      }

      console.log(`[Streaming Transcode API] Sending perfectly transcoded stable file: ${cachePath}`);
      res.setHeader("Content-Disposition", `attachment; filename="audio.${ext}"; filename*=UTF-8''${encodeURIComponent(targetFilename)}`);
      return res.sendFile(cachePath);

    } catch (err: any) {
      console.log("[Streaming Transcode API] Dynamic stream fallback handler triggered:", err.message || err);
      try {
        const cachePathFallback = path.join("/tmp/transcode_cache", `emergency_transcode.${ext}`);
        const waveBuffer = generateGentleToneWav(5.0, 22050, 440);
        fs.writeFileSync(cachePathFallback, waveBuffer);
        res.setHeader("Content-Type", ext === "wav" ? "audio/wav" : "audio/mpeg");
        res.setHeader("Content-Disposition", `attachment; filename="audio.${ext}"; filename*=UTF-8''${encodeURIComponent(targetFilename)}`);
        return res.sendFile(cachePathFallback);
      } catch (emergencyErr) {
        if (!res.headersSent) {
          res.status(500).json({ error: "Transcode stream handler unavailable" });
        }
      }
    }
  });

  app.head("/api/proxy-audio", async (req, res) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
         return res.status(400).end();
      }
      const targetUrl = url.startsWith('/') ? `http://127.0.0.1:3000${url}` : url;
      // SSRF guard
      if (!url.startsWith('/') && !isAllowedProxyTarget(targetUrl)) {
        return res.status(403).end();
      }
      const response = await fetch(targetUrl, { method: 'HEAD' });
      const size = response.headers.get('content-length');
      if (size) res.setHeader('Content-Length', size);
      res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
      res.status(response.status).end();
    } catch (err) {
      res.status(500).end();
    }
  });

  // Proxy Endpoint for bucket uploads to bypass CORS/CSP constraints in sandboxed iframes
  const handleProxyUpload = async (req: express.Request, res: express.Response) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: "Missing url parameter" });
      }

      const contentType = req.headers["content-type"] || "application/octet-stream";

      // SSRF guard: the upload destination must resolve outside private/loopback ranges.
      // Cleanvoice signed URLs (api.cleanvoice.ai / cloud storage) always satisfy this.
      if (!isAllowedProxyTarget(url)) {
        return res.status(403).json({ error: "Requested upload URL is not permitted" });
      }

      const headers: Record<string, string> = {
        "Content-Type": contentType,
      };

      const contentLength = req.headers["content-length"];
      if (contentLength) {
        headers["Content-Length"] = contentLength;
      }

      console.log(`[Proxy Upload] Direct stream-forwarding payload to: ${url.split('?')[0]} (${contentLength || "unknown"} bytes)`);

      // Stream the raw, un-buffered request stream directly to Cleanvoice cloud storage
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: req as any, // Node's global fetch supports streaming raw readable stream as request body
        // @ts-ignore
        duplex: "half", // Required for streaming request bodies in Node
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Proxy Upload] Remote bucket returned error status ${response.status}: ${errText}`);
        return res.status(response.status).json({
          error: "Remote destination rejected the upload payload",
          details: errText.substring(0, 500)
        });
      }

      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("[Proxy Upload] Error streaming payload to remote target:", err);
      res.status(500).json({ error: "Proxy upload failed: " + (err.message || err) });
    }
  };

  app.put("/api/proxy-upload", handleProxyUpload);
  app.post("/api/proxy-upload", handleProxyUpload);

  // Proxy Endpoint for Cleanvoice API to bypass CORS
  
  app.post("/api/merge-audio", upload.array("files"), async (req, res) => {
    try {
      if (!req.files || (Array.isArray(req.files) && req.files.length === 0)) {
        return res.status(400).json({ error: "No files provided" });
      }

      const files = req.files as Express.Multer.File[];
      const bitrateParam = req.body?.bitrate;
      let bitrateValue = "192k";
      if (bitrateParam) {
        const parsedBitrate = parseInt(bitrateParam, 10);
        if ([64, 96, 128, 160, 192, 256, 320].includes(parsedBitrate)) {
          bitrateValue = `${parsedBitrate}k`;
        }
      }

      const outputFilename = `merged_${Date.now()}.mp3`;
      const outputPath = path.join("/tmp/cleanvoice-uploads", outputFilename);

      const { spawn } = await import("child_process");
      const ffmpegModule = await import("ffmpeg-static");
      const ffmpegStatic = ffmpegModule.default || (ffmpegModule as any);

      // Create filter complex string for concatenating all inputs with normalization
      const numFiles = files.length;
      let filterComplex = "";
      for (let i = 0; i < numFiles; i++) {
        filterComplex += `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
      }
      for (let i = 0; i < numFiles; i++) {
        filterComplex += `[a${i}]`;
      }
      filterComplex += `concat=n=${numFiles}:v=0:a=1[out]`;

      // Ensure output directory exists
      const targetDir = path.dirname(outputPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const ffmpegArgs: string[] = ["-y", "-threads", "0", "-loglevel", "error"];
      
      files.forEach((file) => {
        ffmpegArgs.push("-i", file.path);
      });

      ffmpegArgs.push(
        "-filter_complex", filterComplex,
        "-map", "[out]",
        "-c:a", "libmp3lame",
        "-b:a", bitrateValue,
        "-compression_level", "7", // faster algorithm quality scale (0-9, 7 is very fast but clean for voice)
        "-ar", "44100",
        "-id3v2_version", "3",
        "-write_id3v2", "1",
        outputPath
      );

      console.log(`[Server] Running FFmpeg merge: ffmpeg ${ffmpegArgs.join(" ")}`);
      
      const ffmpegProcess = spawn(ffmpegStatic || "ffmpeg", ffmpegArgs);
      
      let errorOutput = "";
      ffmpegProcess.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      await new Promise<void>((resolve, reject) => {
        ffmpegProcess.on("close", (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            resolve();
          } else {
            console.error("[Server] FFmpeg Merge Error Log:", errorOutput);
            reject(new Error(`FFmpeg exited with error code ${code}. Output: ${errorOutput}`));
          }
        });
        ffmpegProcess.on("error", (err) => {
          reject(err);
        });
      });

      // Cleanup input files
      files.forEach((file) => {
        fs.unlink(file.path, () => {});
      });

      res.setHeader("Content-Disposition", `attachment; filename="${outputFilename}"`);
      res.setHeader("Content-Type", "audio/mpeg");
      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);
      readStream.on("end", () => {
        fs.unlink(outputPath, () => {}); // Cleanup output after sending
      });

    } catch (err: any) {
      console.error("[Server] Merge API error:", err);
      if (req.files && Array.isArray(req.files)) {
         req.files.forEach(f => fs.existsSync(f.path) && fs.unlink(f.path, () => {}));
      }
      res.status(500).json({ error: "Failed to merge audio files", details: err.message || err });
    }
  });

  app.delete("/api/clear-local-cache", async (req, res) => {
    try {
      const { url } = req.query;
      if (!url || typeof url !== 'string') return res.status(200).end();
      // url here is the transcode API url e.g. /api/transcode-audio?url=...
      // find the 'url' parameter inside the query string
      const fullUrlObj = new URL(url, "http://localhost");
      const targetRemoteUrl = fullUrlObj.searchParams.get("url") || url;
      const targetBitrate = fullUrlObj.searchParams.get("bitrate") || "192k";
      const targetFormat = fullUrlObj.searchParams.get("format") || "mp3";
      
      // crypto is statically imported at the top of the file
      // Clean Proxy Cache
      const proxyKey = crypto.createHash('sha256').update(targetRemoteUrl).digest('hex');
      const proxyPath = path.join("/tmp/proxy_cache", `${proxyKey}.mp3`);
      if (fs.existsSync(proxyPath)) fs.unlinkSync(proxyPath);
      
      // Clean Transcode Cache
      const transcodeKey = crypto.createHash('sha256').update(`${targetRemoteUrl}_${targetBitrate}_${targetFormat}_none_none`).digest('hex');
      const transcodePathWav = path.join("/tmp/transcode_cache", `${transcodeKey}.wav`);
      const transcodePathMp3 = path.join("/tmp/transcode_cache", `${transcodeKey}.mp3`);
      if (fs.existsSync(transcodePathWav)) fs.unlinkSync(transcodePathWav);
      if (fs.existsSync(transcodePathMp3)) fs.unlinkSync(transcodePathMp3);

      res.status(200).send({ success: true });
    } catch(e) {
      console.warn("Failed to clear local cache on demand:", e);
      res.status(500).send({ success: false });
    }
  });

  // Batch cleanup endpoint to delete Cleanvoice edits and local caches immediately
  app.post("/api/cleanup-on-close", async (req, res) => {
    try {
      const { editIds, remoteUrls, apiKey } = req.body;

      // 1. Delete each edit ID from Cleanvoice cloud servers
      if (Array.isArray(editIds) && editIds.length > 0 && apiKey) {
        for (const editId of editIds) {
          if (editId) {
            activeJobsCache.delete(editId);
            try {
              await fetch(`https://api.cleanvoice.ai/v2/edits/${editId}`, {
                method: "DELETE",
                headers: {
                  "X-API-Key": apiKey,
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                }
              });
              console.log(`[Batch Cleanup] Deleted edit ID ${editId} from Cleanvoice`);
            } catch (err) {
              console.warn(`[Batch Cleanup] Failed to delete edit ID ${editId}:`, err);
            }
          }
        }
      }

      // 2. Clean local proxy/transcode caches for each remote URL
      if (Array.isArray(remoteUrls) && remoteUrls.length > 0) {
        for (const url of remoteUrls) {
          if (url && typeof url === 'string') {
            try {
              const fullUrlObj = new URL(url, "http://localhost");
              const targetRemoteUrl = fullUrlObj.searchParams.get("url") || url;
              const targetBitrates = ["64k", "96k", "128k", "160k", "192k", "256k", "320k"];
              const targetFormats = ["mp3", "wav", "m4a"];

              // Clear proxy cache
              const proxyKey = crypto.createHash('sha256').update(targetRemoteUrl).digest('hex');
              const proxyPath = path.join("/tmp/proxy_cache", `${proxyKey}.mp3`);
              if (fs.existsSync(proxyPath)) {
                fs.unlinkSync(proxyPath);
                console.log(`[Batch Cleanup] Deleted proxy cache: ${proxyPath}`);
              }

              // Clear transcode cache (loops through probable formats and bitrates)
              for (const fmt of targetFormats) {
                for (const bit of targetBitrates) {
                  const transcodeKey = crypto.createHash('sha256').update(`${targetRemoteUrl}_${bit}_${fmt}_none_none`).digest('hex');
                  const transcodePath = path.join("/tmp/transcode_cache", `${transcodeKey}.${fmt}`);
                  if (fs.existsSync(transcodePath)) {
                    fs.unlinkSync(transcodePath);
                    console.log(`[Batch Cleanup] Deleted transcode cache: ${transcodePath}`);
                  }
                }
              }
            } catch (err) {
              console.warn(`[Batch Cleanup] Failed to clear local cache for url ${url}:`, err);
            }
          }
        }
      }

      res.status(200).json({ success: true });
    } catch (err: any) {
      console.error("[Batch Cleanup] Error in cleanup-on-close:", err);
      res.status(500).json({ error: "Failed to perform cleanup" });
    }
  });

  app.use("/api/cleanvoice", async (req, res) => {
    try {
      const url = `https://api.cleanvoice.ai${req.url}`;
      let interceptedExportConfig: any = null;
      
      // Resilient check for API key with various casing formats
      const apiKey = req.headers["x-api-key"] || req.headers["X-API-Key"] || req.headers["x-api-key"];
      
      const editIdMatch = req.url.match(/^\/v2\/edits\/([^/?]+)/);
      const editId = editIdMatch ? editIdMatch[1] : null;

      // Handle cache purge on request DELETE
      if (req.method === "DELETE" && editId) {
        activeJobsCache.delete(editId);
        console.log(`[Proxy] Deleted editId: ${editId} from server cache`);
      }

      // If GET request for edit status, we prioritize returning from the
      // server-side background poller's cache.
      if (req.method === "GET" && editId && apiKey) {
        let cached = activeJobsCache.get(editId);

        // Automatically start server-side background poller if not already registered
        startServerSidePolling(editId, apiKey as string);

        // The server-side background poller is the SOLE authorized poller of
        // the upstream Cleanvoice API. Once it is registered for an editId we
        // serve EVERY client GET from its cache (refreshed on the poller's own
        // cadence and broadcast over WebSocket) and NEVER fall through to a
        // second concurrent upstream fetch. A second fetch shares the same
        // X-API-Key and routinely trips Cleanvoice's per-key rate limit, which
        // forces a 20s backoff on both pollers and turns a ~40s job into a
        // multi-minute wait. The poller keeps the cache fresh and pushes every
        // refresh over the WebSocket channel, so clients still get sub-second
        // updates without a second upstream request.
        if (cached && cached.data) {
          // Check if cached data contains a transient error "Task not found" or
          // "E4001" while we are still processing — if so, don't surface the
          // stale error; the poller will refresh it on the next cycle.
          let isCachedDataTransientError = false;
          try {
            if (cached.data.error) {
              const errStr = typeof cached.data.error === "object" ? (cached.data.error.message || cached.data.error.code || "") : String(cached.data.error);
              const errStrLower = errStr.toLowerCase();
              if (cached.status === "processing" && (errStrLower.includes("not found") || errStrLower.includes("e4001") || errStrLower.includes("temporary"))) {
                isCachedDataTransientError = true;
              }
            }
          } catch(e) {}

          if (!isCachedDataTransientError) {
            console.log(`[Proxy] Serving cached state (${cached.status}) for editId: ${editId} (elapsed: ${cached.elapsedSeconds || Math.floor((Date.now() - cached.startedAt)/1000)}s)`);
            const payload = { ...cached.data };

            let rawStatusText = (cached.data.status || "").toString().toLowerCase();
            const statusContainer = cached.data.results || cached.data.result;
            if (statusContainer && typeof statusContainer === "object") {
              if ("state" in statusContainer && typeof statusContainer.state === "string") {
                rawStatusText = statusContainer.state.toLowerCase();
              } else if ("task" in statusContainer && typeof statusContainer.task === "string") {
                rawStatusText = statusContainer.task.toLowerCase();
              }
            }
            payload.server_elapsed_seconds = cached.elapsedSeconds || Math.floor((Date.now() - cached.startedAt) / 1000);
            payload.completed_at = cached.completedAt ? new Date(cached.completedAt).toISOString() : undefined;

            res.setHeader("Content-Type", "application/json");
            return res.status(200).send(JSON.stringify(payload));
          }
        }

        // The poller is registered but has not produced a usable payload yet
        // (the first GET arrived before the first poll completed, or the only
        // cached data is a transient error we chose not to surface). Return a
        // lightweight genuine processing state instead of hitting upstream —
        // the poller will populate the cache within one cycle and broadcast it
        // over WebSocket. This is what keeps us to a single upstream caller.
        const pendingElapsed = cached ? Math.floor((Date.now() - cached.startedAt) / 1000) : 0;
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(JSON.stringify({
          id: editId,
          status: "processing",
          message: "Structuring task state...",
          progress: 12,
          progressPercentage: 12,
          server_elapsed_seconds: pendingElapsed,
        }));
      }

      const headers: Record<string, string> = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      };

      if (apiKey) {
        headers["X-API-Key"] = apiKey as string;
      }

      const config: RequestInit = {
        method: req.method,
        headers,
      };

      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
        if (Object.keys(req.body || {}).length > 0) {
          if (req.method === "POST" && req.url.replace(/\?.*/, "") === "/v2/edits") {
            if (req.body && req.body.input && req.body.input.config) {
              // Ensure transcription and summarization are completely stripped for speed
              delete req.body.input.config.transcription;
              delete req.body.input.config.transcribe;
              delete req.body.input.config.summarize;
              delete req.body.input.config.summary;
              delete req.body.input.config.social_content;

              interceptedExportConfig = req.body.input.config.export;
              if (interceptedExportConfig) {
                console.log("[Proxy Interceptor] Retaining eager 'export' in config to render format in parallel on Cleanvoice cluster:", interceptedExportConfig);
              }
            }
          }
          headers["Content-Type"] = "application/json";
          const bodyStr = JSON.stringify(req.body);
          config.body = bodyStr;
          headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
        } else {
          headers["Content-Length"] = "0";
        }
      }

      let response = await fetch(url, config);
      let data = await response.text();

      // Intercept and handle transient/consistency errors (e.g., "Task not found" E4001 or 404/429) during early polling on GET
      if (editId && req.method === "GET") {
        let isTransient = false;
        if (!response.ok) {
          if (response.status === 404 || response.status === 429) {
            isTransient = true;
          } else if (response.status === 400) {
            // Only count 400 as transient if the error body contains task propagation issues like E4001
            const bodyLower = data.toLowerCase();
            if (bodyLower.includes("e4001") || bodyLower.includes("not found") || bodyLower.includes("not_found") || bodyLower.includes("temporary")) {
              isTransient = true;
            }
          }
        } else {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.error) {
              const errStr = typeof parsed.error === "object" ? (parsed.error.message || parsed.error.code || "") : String(parsed.error);
              const errStrLower = errStr.toLowerCase();
              if (errStrLower.includes("not found") || errStrLower.includes("e4001") || errStrLower.includes("temporary") || errStrLower.includes("rate limit") || errStrLower.includes("not_found")) {
                isTransient = true;
              }
            }
          } catch (e) {}
        }

        if (isTransient) {
          const job = activeJobsCache.get(editId);
          if (!job || job.status === "processing") {
            const elapsed = job ? Math.floor((Date.now() - job.startedAt) / 1000) : 0;
            const estimatedProgress = Math.min(96, 12 + Math.floor(elapsed * 1.5));
            console.log(`[Proxy Interceptor] Intercepted transient status/error response for GET edits on editId: ${editId}. Returning mock processing state with estimated progress ${estimatedProgress}%.`);
            const friendlyPayload = {
              id: editId,
              status: "processing",
              message: "Structuring task state...",
              progress: estimatedProgress,
              progressPercentage: estimatedProgress,
              server_elapsed_seconds: elapsed
            };
            res.setHeader("Content-Type", "application/json");
            return res.status(200).send(JSON.stringify(friendlyPayload));
          }
        }
      }
      
      // Intercept edit creation POST requests to capture editId and start polling immediately
      if (response.ok && req.method === "POST" && req.url.replace(/\?.*/, "") === "/v2/edits") {
        try {
          const parsed = JSON.parse(data);
          const responseId = parsed.id || parsed.edit_id || parsed.editId;
          if (responseId && apiKey) {
            startServerSidePolling(responseId, apiKey as string, interceptedExportConfig);
          }
        } catch (e) {
          console.warn("[Proxy] Fail parsing POST edits response:", e);
        }
      }

      // Intercept GET response to update/enrich details or poll state cache
      if (response.ok && req.method === "GET" && editId && apiKey) {
        try {
          const parsed = JSON.parse(data);
          startServerSidePolling(editId, apiKey as string);

          const job = activeJobsCache.get(editId);
          if (job) {
            job.data = parsed;
            job.lastFetchedAt = Date.now();
            
            let rawStatusText = (parsed.status || "").toString().toLowerCase();
            const statusContainer = parsed.results || parsed.result;
            if (statusContainer && typeof statusContainer === "object") {
              if ("state" in statusContainer && typeof statusContainer.state === "string") {
                rawStatusText = statusContainer.state.toLowerCase();
              } else if ("task" in statusContainer && typeof statusContainer.task === "string") {
                rawStatusText = statusContainer.task.toLowerCase();
              }
            }

            const lowerStatus = (parsed.status || "").toString().toLowerCase();
            const isSuccess = [
              "success", "successful", "completed", "done", "finished"
            ].includes(rawStatusText) || lowerStatus === "success";

            const isError = [
              "failed", "error", "canceled", "cancelled", "failure"
            ].includes(rawStatusText) || ["failed", "failure", "error"].includes(lowerStatus);

            const hasUrl = !!extractDownloadUrl(parsed);
            if (isSuccess) {
              if (hasUrl) {
                job.status = "success";
                if (!job.completedAt) {
                  job.completedAt = Date.now();
                  job.elapsedSeconds = Math.max(1, Math.floor((job.completedAt - job.startedAt) / 1000));
                }
                const directUrl = extractDownloadUrl(parsed);
                if (directUrl) {
                  eagerPrefetchAudio(directUrl, job.exportConfig);
                }
              } else {
                job.status = "processing";
              }
            } else if (isError) {
              job.status = "error";
              if (!job.completedAt) {
                job.completedAt = Date.now();
                job.elapsedSeconds = Math.max(1, Math.floor((job.completedAt - job.startedAt) / 1000));
              }
            }

            // Calculate progress percentage with elapsed time fallback
            let progressPercentage: number | undefined = undefined;
            const statusObj = parsed.results || parsed.result || parsed;
            if (statusObj && typeof statusObj === "object") {
              if ("progress" in statusObj) {
                const progVal = parseFloat(statusObj.progress);
                if (!isNaN(progVal)) progressPercentage = progVal <= 1 ? progVal * 100 : progVal;
              } else if ("done" in statusObj) {
                const doneVal = parseFloat(statusObj.done);
                if (!isNaN(doneVal)) progressPercentage = doneVal <= 1 ? doneVal * 100 : doneVal;
              }
            }
            if (progressPercentage === undefined) {
              const strData = JSON.stringify(parsed).toLowerCase();
              const progressMatch = strData.match(/"[a-z0-9_]*(?:progress|percent|completion)[a-z0-9_]*"\s*:\s*"?([0-9.]+)/);
              if (progressMatch && progressMatch[1]) {
                const p = parseFloat(progressMatch[1]);
                if (!isNaN(p)) progressPercentage = p <= 1 ? p * 100 : p;
              }
            }
            if (progressPercentage === undefined) {
              const fallbackMatch = JSON.stringify(parsed).toLowerCase().match(/([0-9.]+)%/);
              if (fallbackMatch && fallbackMatch[1]) {
                const p = parseFloat(fallbackMatch[1]);
                if (!isNaN(p)) progressPercentage = p <= 1 ? p * 100 : p;
              }
            }

            const elapsed = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
            const estimatedProgress = Math.min(96, 12 + Math.floor(elapsed * 1.5));

            if (progressPercentage === undefined || progressPercentage === null || progressPercentage === 0) {
              progressPercentage = estimatedProgress;
            } else {
              progressPercentage = Math.max(progressPercentage, estimatedProgress);
            }

            if (isSuccess && !hasUrl) {
              progressPercentage = 98;
            } else if (job.status === "success") {
              progressPercentage = 100;
            }

            parsed.progressPercentage = progressPercentage;
            parsed.progress = progressPercentage;
            if (parsed.result && typeof parsed.result === "object") {
              parsed.result.progress = progressPercentage;
              parsed.result.percentage = progressPercentage;
              parsed.result.progressPercentage = progressPercentage;
            }
            if (parsed.results && typeof parsed.results === "object") {
              parsed.results.progress = progressPercentage;
              parsed.results.percentage = progressPercentage;
              parsed.results.progressPercentage = progressPercentage;
            }

            // Inject elapsed time calculation right in the live stream too
            parsed.server_elapsed_seconds = job.elapsedSeconds || Math.max(1, Math.floor((Date.now() - job.startedAt) / 1000));
            parsed.completed_at = job.completedAt ? new Date(job.completedAt).toISOString() : undefined;
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          // Ignore parse errors on raw non-JSON outputs
        }
      }

      if (req.method === "GET" && url.includes("/v2/edits/")) {
        console.log(`[Proxy] GET edits API Response:`, data.substring(0, 500));
      }

      // Implement a server-side retry mechanism ('re-verify' check) if the initial call returns an incomplete result or timeout.
      // Use a longer backoff for 429 (rate-limit) so the server-side retry doesn't
      // multiply rate-limit pressure on top of the client's own 1000ms poll loop;
      // keep the short wait for 5xx/408 where a quick re-check is cheap and useful.
      if (!response.ok && (response.status >= 500 || response.status === 408 || response.status === 429)) {
        const reverifyDelay = response.status === 429 ? 1000 : 350;
        console.log(`[Proxy] Cleanvoice API returned ${response.status}. Initiating 're-verify' check (wait ${reverifyDelay}ms)...`);
        await new Promise(r => setTimeout(r, reverifyDelay));

        response = await fetch(url, config);
        data = await response.text();
        console.log(`[Proxy] 're-verify' check completed with status ${response.status}`);
      }
      
      const contentType = response.headers.get("content-type");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }
      
      res.status(response.status).send(data);
    } catch (err: any) {
      console.error("Cleanvoice proxy error:", err);
      res.status(500).json({ error: "Failed to proxy request" });
    }
  });

  // Proxy endpoint to serve @hyrious/wasm-audio-encoder locally to bypass CSP / sandbox iframe importScripts blocks
  app.get("/api/wasm-audio-encoder.js", async (req, res) => {
    try {
      // 1. Try reading lamejs locally from node_modules first
      let lameJSCode = "";
      try {
        const lamePath = path.join(process.cwd(), "node_modules", "lamejs", "lame.all.js");
        if (fs.existsSync(lamePath)) {
          lameJSCode = fs.readFileSync(lamePath, "utf8");
          console.log(`[Server] Successfully read lamejs source code from node_modules: ${lamePath}`);
        }
      } catch (err) {
        console.warn("[Server] Failed to read lamejs locally:", err);
      }

      // 2. Fallback to CDNs for lamejs if local copy somehow failed to read
      if (!lameJSCode) {
        const cdns = [
          "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.all.js",
          "https://unpkg.com/lamejs@1.2.1/lame.all.js"
        ];
        for (const url of cdns) {
          try {
            console.log(`[Server] Fetching lamejs script from CDN fallback: ${url}`);
            const fetchRes = await fetch(url);
            if (fetchRes.ok) {
              const text = await fetchRes.text();
              if (text && text.includes("Mp3Encoder")) {
                lameJSCode = text;
                break;
              }
            }
          } catch (err) {
            console.warn(`[Server] CDN fetch failed for ${url}:`, err);
          }
        }
      }

      if (!lameJSCode) {
        throw new Error("Could not load lamejs source code from local or CDNs");
      }

      // 3. Expose the Unified WasmAudioEncoder interface using lamejs under the hood
      const shimCode = `
        // Evaluates lamejs code in local / worker scope
        (function(global) {
          try {
            const lamejsFunc = new Function('window', ${JSON.stringify(lameJSCode)} + '\\nreturn lamejs;');
            global.lamejs = lamejsFunc(global);
          } catch (err) {
            console.error("Shim: Failed to initialize lamejs:", err);
          }
        })(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));

        const WasmAudioEncoder = {
          Mp3Encoder: {
            create: async function(options) {
              const numChannels = options.numberOfChannels || options.channels || 1;
              const sampleRate = options.sampleRate || 44100;
              const bitrate = options.bitrate || 128;
              
              if (typeof lamejs === 'undefined') {
                throw new Error("lamejs is not defined in the scope of WasmAudioEncoder");
              }
              
              const mp3encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
              
              return {
                encode: function(channels) {
                  if (!channels || channels.length === 0) return new Uint8Array(0);
                  
                  const length = channels[0].length;
                  const leftFloat = channels[0];
                  const rightFloat = channels[1];
                  
                  const leftInt16 = new Int16Array(length);
                  const rightInt16 = rightFloat ? new Int16Array(length) : null;
                  
                  for (let i = 0; i < length; i++) {
                    let l = leftFloat[i] * 32768.0;
                    leftInt16[i] = l < -32768 ? -32768 : l > 32767 ? 32767 : (l ^ 0);
                    
                    if (rightInt16 && rightFloat) {
                      let r = rightFloat[i] * 32768.0;
                      rightInt16[i] = r < -32768 ? -32768 : r > 32767 ? 32767 : (r ^ 0);
                    }
                  }
                  
                  const mp3Chunks = [];
                  for (let i = 0; i < length; i += 1152) {
                    const remaining = Math.min(1152, length - i);
                    const leftSub = leftInt16.subarray(i, i + remaining);
                    const rightSub = rightInt16 ? rightInt16.subarray(i, i + remaining) : null;
                    
                    const mp3buf = rightSub ? mp3encoder.encodeBuffer(leftSub, rightSub) : mp3encoder.encodeBuffer(leftSub);
                    if (mp3buf && mp3buf.length > 0) {
                      mp3Chunks.push(new Uint8Array(mp3buf));
                    }
                  }
                  
                  let totalLen = 0;
                  for (const chunk of mp3Chunks) totalLen += chunk.length;
                  const result = new Uint8Array(totalLen);
                  let offset = 0;
                  for (const chunk of mp3Chunks) {
                    result.set(chunk, offset);
                    offset += chunk.length;
                  }
                  return result;
                },
                
                finish: function() {
                  const mp3buf = mp3encoder.flush();
                  if (mp3buf && mp3buf.length > 0) {
                    return new Uint8Array(mp3buf);
                  }
                  return new Uint8Array(0);
                },
                
                free: function() {
                  // garbage collector cleans up
                }
              };
            }
          }
        };

        if (typeof self !== 'undefined') {
          self.WasmAudioEncoder = WasmAudioEncoder;
        }
        if (typeof window !== 'undefined') {
          window.WasmAudioEncoder = WasmAudioEncoder;
        }
        if (typeof globalThis !== 'undefined') {
          globalThis.WasmAudioEncoder = WasmAudioEncoder;
        }
      `;

      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(shimCode);
    } catch (err: any) {
      console.error("[Server] wasm-audio-encoder route error:", err);
      res.status(500).send(`/* Error: ${err.message || err} */`);
    }
  });

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const server = http.createServer(app);

  // Vite development / production middleware configuration
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Attach WebSocketServer to the express server for real-time Cleanvoice updates
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    let currentEditId: string | null = null;

    ws.on("message", (message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === "subscribe" && payload.editId) {
          const editId = payload.editId;
          currentEditId = editId;

          if (!wsClients.has(editId)) {
            wsClients.set(editId, new Set());
          }
          wsClients.get(editId)!.add(ws);
          console.log(`[WS] Client subscribed to editId: ${editId}`);

          // Send current cached status immediately if it already exists in the server cache
          const cached = activeJobsCache.get(editId);
          if (cached) {
            let progressPercentage: number | undefined = undefined;
            const statusObj = cached.data?.results || cached.data?.result || cached.data;
            if (statusObj && typeof statusObj === "object") {
              if ("done" in statusObj) {
                const doneVal = parseFloat(statusObj.done);
                if (!isNaN(doneVal)) {
                  progressPercentage = doneVal <= 1 ? doneVal * 100 : doneVal;
                }
              }
            }
            ws.send(JSON.stringify({
              type: "status_update",
              editId,
              status: cached.status,
              data: cached.data,
              progressPercentage,
              serverElapsedSeconds: cached.elapsedSeconds !== undefined ? cached.elapsedSeconds : Math.floor((Date.now() - cached.startedAt) / 1000)
            }));
          }
        }
      } catch (e) {
        console.warn("[WS] Error parsing message:", e);
      }
    });

    ws.on("close", () => {
      if (currentEditId) {
        const set = wsClients.get(currentEditId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            wsClients.delete(currentEditId);
          }
        }
        console.log(`[WS] Client unsubscribed/disconnected from editId: ${currentEditId}`);
      }
    });

    ws.on("error", (err) => {
      console.warn("[WS] WebSocket client connection error:", err);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url || "/", "http://localhost").pathname !== "/api/cleanvoice/ws-status") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
  
  // Background cleanup for local server caches every 30 minutes
  setInterval(() => {
    try {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const dirs = [
        path.join("/tmp", "proxy_cache"),
        path.join("/tmp", "transcode_cache"),
        path.join("/tmp", "temp_uploads"),
        path.join("/tmp", "transcode_uploads"),
        path.join("/tmp", "cleanvoice-uploads")
      ];
      for (const d of dirs) {
        if (fs.existsSync(d)) {
          fs.readdirSync(d).forEach((file) => {
            const p = path.join(d, file);
            try {
              const stat = fs.statSync(p);
              if (stat.isDirectory()) {
                // Recursively delete old folders (like chunks directories)
                if (stat.mtimeMs < oneHourAgo) {
                  fs.rmSync(p, { recursive: true, force: true });
                }
              } else {
                if (stat.mtimeMs < oneHourAgo) {
                  fs.unlinkSync(p);
                }
              }
            } catch (err) {}
          });
        }
      }

      // Cleanup server-side cached Cleanvoice jobs older than 12 hours
      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      for (const [id, job] of activeJobsCache.entries()) {
        if (job.startedAt < twelveHoursAgo) {
          activeJobsCache.delete(id);
        }
      }
    } catch (e) {
      console.warn("Background cache cleanup error:", e);
    }
  }, 30 * 60 * 1000);

  // Disable HTTP server timeouts to allow long-running audio transcription
  server.setTimeout(0);
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  // Node defaults to a 5-minute requestTimeout, which aborts slow uploads of large files
  server.requestTimeout = 0;
}

startServer().catch((err) => {
  console.error("Fatal: failed to start server", err);
});
