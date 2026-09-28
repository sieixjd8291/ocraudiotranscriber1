// Type-only import: this module is also used by the main UI bundle, which
// lazy-loads the @google/genai SDK, so the runtime enum must not be pulled in.
import type { ThinkingConfig, ThinkingLevel as ThinkingLevelEnum } from "@google/genai";

const ThinkingLevel = {
  MINIMAL: "MINIMAL" as ThinkingLevelEnum.MINIMAL,
  LOW: "LOW" as ThinkingLevelEnum.LOW,
};

/** All models offered for manual selection and API-key verification. */
export const GEMINI_MODEL_HIERARCHY = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
] as const;

/** Automatic switching is limited to the two Flash Lite models. */
const FLASH_LITE_FALLBACK = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"] as const;

export type GeminiModelId = (typeof GEMINI_MODEL_HIERARCHY)[number];

export const PRIMARY_GEMINI_MODEL: GeminiModelId = GEMINI_MODEL_HIERARCHY[0];

export const GEMINI_MODEL_NAMES: Record<GeminiModelId, string> = {
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
};

export function isKnownGeminiModel(model: string | null | undefined): model is GeminiModelId {
  return !!model && (GEMINI_MODEL_HIERARCHY as readonly string[]).includes(model);
}

/** Manual Flash choices run alone; only Flash Lite selections switch automatically. */
export function buildModelOrder(preferredModel?: string | null): string[] {
  const start = isKnownGeminiModel(preferredModel) ? preferredModel : PRIMARY_GEMINI_MODEL;
  if (!FLASH_LITE_FALLBACK.some((model) => model === start)) return [start];
  return [start, ...FLASH_LITE_FALLBACK.filter((model) => model !== start)];
}

/**
 * Gemini 3.5+ models always think and reject the legacy `thinkingBudget: 0`
 * ("disable thinking") with 400 INVALID_ARGUMENT — that is exactly the error
 * gemini-3.5-flash-lite was returning. They take `thinkingLevel` instead, and
 * gemini-3.1-flash-lite still accepts `thinkingBudget: 0`, which is proven to
 * work in production, so it keeps that setting.
 */
const THINKING_CONFIG_BY_MODEL: Record<GeminiModelId, ThinkingConfig> = {
  "gemini-3.5-flash-lite": { thinkingLevel: ThinkingLevel.MINIMAL },
  "gemini-3.1-flash-lite": { thinkingBudget: 0 },
  "gemini-3.8-flash": { thinkingLevel: ThinkingLevel.LOW },
  "gemini-3.7-flash": { thinkingLevel: ThinkingLevel.LOW },
  "gemini-3.6-flash": { thinkingLevel: ThinkingLevel.MINIMAL },
  "gemini-3.5-flash": { thinkingLevel: ThinkingLevel.MINIMAL },
};

export function getThinkingConfig(model: string): ThinkingConfig | undefined {
  return isKnownGeminiModel(model) ? THINKING_CONFIG_BY_MODEL[model] : undefined;
}

/** True for 400 INVALID_ARGUMENT — a request-shape problem, not an outage. */
export function isInvalidArgumentError(error: any): boolean {
  if (!error) return false;
  const status = Number(error.status ?? error.code ?? error.response?.status);
  const msg = String(error.message || error).toLowerCase();
  return status === 400 || msg.includes("invalid_argument") || msg.includes("invalid argument") || msg.includes('"code": 400') || msg.includes('"code":400');
}
