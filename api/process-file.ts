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

// Vercel rejects request bodies over 4.5 MB before they reach the function.
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
// Cool-downs between full sweeps of the model list when EVERY model returned
// an overload error. Kept well inside the function's maxDuration (vercel.json).
const SWEEP_COOLDOWNS_MS = [5000, 10000, 20000, 30000];
const MODEL_ID_PATTERN = /^gemini-[a-z0-9.-]+$/;
const DEFAULT_MODEL_PLAN: ModelPlanEntry[] = [
  { model: "gemini-3.5-flash-lite", thinkingConfig: { thinkingLevel: "MINIMAL" } },
  { model: "gemini-3.1-flash-lite", thinkingConfig: { thinkingBudget: 0 } },
];

type ThinkingConfig = { thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"; thinkingBudget?: number };
type ModelPlanEntry = { model: string; thinkingConfig?: ThinkingConfig };

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
    const plan: ModelPlanEntry[] = [];
    for (const entry of parsed.slice(0, 10)) {
      if (!entry || typeof entry.model !== "string" || !MODEL_ID_PATTERN.test(entry.model)) continue;
      const tc = entry.thinkingConfig;
      let thinkingConfig: ThinkingConfig | undefined;
      if (tc && typeof tc === "object") {
        if (["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(tc.thinkingLevel)) {
          thinkingConfig = { thinkingLevel: tc.thinkingLevel };
        } else if (Number.isInteger(tc.thinkingBudget) && tc.thinkingBudget >= -1 && tc.thinkingBudget <= 32768) {
          thinkingConfig = { thinkingBudget: tc.thinkingBudget };
        }
      }
      if (!plan.some((p) => p.model === entry.model)) plan.push({ model: entry.model, thinkingConfig });
    }
    return plan.length ? plan : DEFAULT_MODEL_PLAN;
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

  try {
    sweepLoop: for (let sweep = 0; sweep <= SWEEP_COOLDOWNS_MS.length; sweep++) {
      if (sweep > 0) {
        if (!errors.every((e) => e.overloaded)) break;
        const cooldown = SWEEP_COOLDOWNS_MS[sweep - 1];
        console.log(`[api/process-file] All models overloaded, cooling down ${cooldown / 1000}s before sweep ${sweep + 1}`);
        errors.length = 0;
        await sleep(cooldown, signal);
      }

      for (const { model, thinkingConfig } of modelPlan) {
        // One try per model per sweep, plus one retry without the thinking
        // setting if the model rejects the request shape (400).
        for (const useThinking of thinkingConfig ? [true, false] : [false]) {
          try {
            const stream = await ai.models.generateContentStream({
              model,
              contents,
              config: {
                systemInstruction: prompt,
                temperature: 0,
                abortSignal: signal,
                ...(useThinking ? { thinkingConfig: thinkingConfig as any } : {}),
              },
            });
            // Read the first chunk before committing headers: Gemini often
            // reports 503 on the first read, and after headers are sent we can
            // no longer fall back to another model.
            const it = stream[Symbol.asyncIterator]();
            const first = await it.next();
            firstChunkText = first.done ? "" : first.value?.text || "";
            iterator = it;
            modelUsed = model;
            break sweepLoop;
          } catch (err: any) {
            if (signal.aborted) throw err;
            const message = String(err?.message || err);
            console.log(`[api/process-file] ${model} failed (status ${errorStatus(err) || "?"}): ${message.slice(0, 300)}`);
            if (isAuthError(err)) {
              return json({ error: message, code: "AUTH" }, 401);
            }
            if (useThinking && isInvalidArgument(err)) continue;
            errors.push({ model, message, overloaded: isOverloaded(err) });
            break;
          }
        }
      }
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

  console.log(`[api/process-file] Streaming transcript from ${modelUsed}`);
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
    },
  });
}
