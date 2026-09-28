// Vercel Node.js Function: server-side Gemini transcription.
//
// The Express server.ts is never deployed on Vercel (vercel.json only runs
// `vite build`), so before this file existed every production transcription
// ran straight from the browser. This function is the production equivalent
// of server.ts's POST /api/process-file and speaks the same wire protocol:
//   request : multipart form — file, mimeType, prompt, modelPlan (JSON)
//             + X-Gemini-API-Key header (or GEMINI_API_KEY env var)
//   success : 200 text/plain stream of transcript text, `x-model-used` header,
//             mid-stream failures appended as "---GEMINI-STREAM-ERROR---: ..."
//   failure : JSON { error, code } with 400 / 401 / 413 / 503
//
// The model order + per-model thinking settings come from the client
// (src/services/geminiModels.ts is the single source of truth); they are
// validated here so a caller can't smuggle arbitrary config through.

import { GoogleGenAI } from "@google/genai";
import { raceTimingsFor, raceToFirstChunk } from "../src/services/geminiRace.js";
import { buildModelOrder, getThinkingConfig, isKnownGeminiModel } from "../src/services/geminiModels.js";

// Vercel rejects request bodies over 4.5 MB before they reach the function.
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
type ModelPlanEntry = { model: string; thinkingConfig?: unknown };

const DEFAULT_MODEL_PLAN: ModelPlanEntry[] = buildModelOrder().map((model) => ({
  model,
  thinkingConfig: getThinkingConfig(model),
}));

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function parseModelPlan(raw: FormDataEntryValue | null): ModelPlanEntry[] {
  if (typeof raw !== "string" || !raw) return DEFAULT_MODEL_PLAN;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_MODEL_PLAN;
    const preferred = parsed.find((entry) => isKnownGeminiModel(entry?.model))?.model;
    return buildModelOrder(preferred).map((model) => ({ model, thinkingConfig: getThinkingConfig(model) }));
  } catch {
    return DEFAULT_MODEL_PLAN;
  }
}

function errorStatus(err: any): number {
  return Number(err?.status ?? err?.code ?? err?.response?.status) || 0;
}

function isAuthError(err: any): boolean {
  const msg = String(err?.message || err).toLowerCase();
  return (
    errorStatus(err) === 401 ||
    errorStatus(err) === 403 ||
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("invalid api key") ||
    msg.includes("permission_denied")
  );
}

function isInvalidArgument(err: any): boolean {
  const msg = String(err?.message || err).toLowerCase();
  return errorStatus(err) === 400 || msg.includes("invalid_argument") || msg.includes("invalid argument");
}

function isOverloaded(err: any): boolean {
  if ([429, 500, 502, 503, 504].includes(errorStatus(err))) return true;
  const msg = String(err?.message || err).toLowerCase();
  return ["unavailable", "high demand", "overloaded", "resource_exhausted", "deadline", "internal", "503", "429"].some((s) =>
    msg.includes(s),
  );
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = (process.env.GEMINI_API_KEY || request.headers.get("x-gemini-api-key") || "").trim();
  if (!apiKey) {
    return json({ error: "No Gemini API key was provided. Add your key in the app settings.", code: "NO_API_KEY" }, 401);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Could not read the uploaded form data.", code: "BAD_FORM" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return json({ error: "No file was uploaded.", code: "NO_FILE" }, 400);
  }
  if (file.size > MAX_INLINE_BYTES) {
    return json({ error: "File is too large for the server route.", code: "FILE_TOO_LARGE" }, 413);
  }

  let mimeType = String(form.get("mimeType") || file.type || "application/octet-stream");
  if (mimeType.includes(";")) mimeType = mimeType.split(";")[0].trim();
  const prompt = String(form.get("prompt") || "") ||
    "You are an expert audio transcription assistant. Transcribe the attached media verbatim.";
  const modelPlan = parseModelPlan(form.get("modelPlan"));

  const ai = new GoogleGenAI(apiKey.startsWith("ya29.") ? { authToken: apiKey } as any : { apiKey });
  const base64Data = Buffer.from(await file.arrayBuffer()).toString("base64");
  const contents = {
    parts: [
      { inlineData: { data: base64Data, mimeType } },
      {
        text: mimeType.startsWith("image/")
          ? "Extract text verbatim."
          : "Classify and transcribe verbatim, following system-defined transliteration/transcription rules.",
      },
    ],
  };

  const signal = request.signal;
  const errors: { model: string; message: string; overloaded: boolean }[] = [];
  let iterator: AsyncIterator<any> | null = null;
  let firstChunkText = "";
  let modelUsed = "";
  const requestStart = Date.now();
  const timings = raceTimingsFor(file.size);

  try {
    // Read the first chunk before committing headers, while the other Flash Lite
    // model can take over if the preferred one fails or stalls.
    const { winner, errors: raceErrors } = await raceToFirstChunk<any>({
      plan: modelPlan,
      signal,
      ...timings,
      maxParallel: 2,
      isFatal: isAuthError,
      isInvalidArgument,
      log: (message) => console.log(`[api/process-file] ${message}`),
      start: (entry, useThinking, attemptSignal) =>
        ai.models.generateContentStream({
          model: entry.model,
          contents,
          config: {
            systemInstruction: prompt,
            temperature: 0,
            abortSignal: attemptSignal,
            ...(useThinking && entry.thinkingConfig ? { thinkingConfig: entry.thinkingConfig as any } : {}),
          },
        }),
    });

    if (signal.aborted) return json({ error: "Request aborted.", code: "ABORTED" }, 499);

    const fatal = raceErrors.find((e) => isAuthError(e.error));
    if (fatal) return json({ error: String(fatal.error?.message || fatal.error), code: "AUTH" }, 401);

    for (const e of raceErrors) {
      errors.push({ model: e.model, message: String(e.error?.message || e.error), overloaded: isOverloaded(e.error) });
    }

    if (winner) {
      firstChunkText = winner.first.done ? "" : winner.first.value?.text || "";
      iterator = winner.iterator;
      modelUsed = winner.model;
    }
  } catch (err: any) {
    if (signal.aborted) return json({ error: "Request aborted.", code: "ABORTED" }, 499);
    return json({ error: String(err?.message || err), code: "UNKNOWN" }, 500);
  }

  if (!iterator) {
    const allOverloaded = errors.length > 0 && errors.every((e) => e.overloaded);
    return json(
      {
        error: allOverloaded
          ? "Google's Gemini servers are overloaded for every model right now (503 high demand). Please try again in a few minutes."
          : errors.map((e) => `${e.model}: ${e.message}`).join(" | ") || "All Gemini models failed.",
        code: allOverloaded ? "ALL_MODELS_OVERLOADED" : "ALL_MODELS_FAILED",
      },
      allOverloaded ? 503 : 502,
    );
  }

  const timeToFirstChunkMs = Date.now() - requestStart;
  console.log(`[api/process-file] Streaming transcript from ${modelUsed} (first chunk after ${timeToFirstChunkMs}ms)`);
  const encoder = new TextEncoder();
  const activeIterator = iterator;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (firstChunkText) controller.enqueue(encoder.encode(firstChunkText));
        while (true) {
          const { value, done } = await activeIterator.next();
          if (done) break;
          if (value?.text) controller.enqueue(encoder.encode(value.text));
        }
      } catch (err: any) {
        if (!signal.aborted) {
          controller.enqueue(encoder.encode(`\n---GEMINI-STREAM-ERROR---: ${String(err?.message || err)}`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-model-used": modelUsed,
      "Server-Timing": `gemini-first-chunk;dur=${timeToFirstChunkMs}`,
    },
  });
}
