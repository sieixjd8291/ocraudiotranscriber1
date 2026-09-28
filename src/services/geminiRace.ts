// Shared by the browser (geminiService.ts) and the Vercel function
// (api/process-file.ts). No runtime SDK import so it stays out of the main bundle.
//
// Why this exists: under load, Gemini can take a long time to reject a busy
// model. Trying the models strictly one after another adds that delay before
// the fallback can begin. Instead we:
//   1. start the first model,
//   2. if it hasn't produced its first chunk after `hedgeAfterMs`, start the
//      next model in parallel (at most `maxParallel` in flight),
//   3. keep whichever model streams first and abort the rest,
//   4. give up on an attempt that hasn't streamed after `firstChunkTimeoutMs`.
// The model order is still respected: a later model only runs when an earlier
// one failed or is being slow.

export type RacePlanEntry = { model: string; thinkingConfig?: unknown };

export interface RaceWinner<T> {
  model: string;
  iterator: AsyncIterator<T>;
  first: IteratorResult<T>;
  signal: AbortSignal;
}

export interface RaceError {
  model: string;
  error: any;
}

export interface RaceOptions<T> {
  plan: RacePlanEntry[];
  start: (entry: RacePlanEntry, useThinking: boolean, signal: AbortSignal) => Promise<AsyncIterable<T>>;
  signal?: AbortSignal;
  hedgeAfterMs: number;
  firstChunkTimeoutMs: number;
  maxParallel?: number;
  /** Errors that make every other model pointless too (e.g. an invalid key). */
  isFatal?: (err: any) => boolean;
  /** 400s: the model rejected the request shape; retried once without thinkingConfig. */
  isInvalidArgument?: (err: any) => boolean;
  log?: (message: string) => void;
}

export class FirstChunkTimeoutError extends Error {
  status = 504;
  constructor(model: string, ms: number) {
    super(`${model} did not start responding within ${Math.round(ms / 1000)}s (timeout)`);
    this.name = "FirstChunkTimeoutError";
  }
}

/** Start the other Flash Lite model after five seconds without transcript text. */
export function raceTimingsFor(_fileBytes: number): { hedgeAfterMs: number; firstChunkTimeoutMs: number } {
  return { hedgeAfterMs: 5000, firstChunkTimeoutMs: 10000 };
}

export function raceToFirstChunk<T>(options: RaceOptions<T>): Promise<{ winner: RaceWinner<T> | null; errors: RaceError[] }> {
  const { plan, start, signal: outerSignal, hedgeAfterMs, firstChunkTimeoutMs, isFatal, isInvalidArgument, log } = options;
  const maxParallel = Math.max(1, options.maxParallel ?? 2);

  return new Promise((resolve) => {
    const errors: RaceError[] = [];
    const controllers = new Set<AbortController>();
    let nextIndex = 0;
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (winner: (RaceWinner<T> & { controller: AbortController }) | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      for (const controller of controllers) {
        if (controller !== winner?.controller) controller.abort();
      }
      if (winner) {
        // Keep cancelling the winning stream if the caller aborts later.
        outerSignal?.addEventListener("abort", () => winner.controller.abort(), { once: true });
        const { controller: _controller, ...publicWinner } = winner;
        resolve({ winner: publicWinner, errors });
      } else {
        resolve({ winner: null, errors });
      }
    };

    const onOuterAbort = () => finish(null);
    if (outerSignal?.aborted) {
      resolve({ winner: null, errors });
      return;
    }
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const attemptOnce = async (entry: RacePlanEntry, useThinking: boolean, controller: AbortController) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, firstChunkTimeoutMs);
      try {
        const stream = await start(entry, useThinking, controller.signal);
        const iterator = stream[Symbol.asyncIterator]();
        let first = await iterator.next();
        while (!first.done && !first.value?.text && !controller.signal.aborted) {
          first = await iterator.next();
        }
        if (timedOut) throw new FirstChunkTimeoutError(entry.model, firstChunkTimeoutMs);
        if (controller.signal.aborted) throw new Error(`${entry.model} request was cancelled`);
        if (first.done) throw new Error(`${entry.model} returned an empty transcript`);
        return { model: entry.model, iterator, first, signal: controller.signal, controller };
      } catch (err) {
        if (timedOut) throw new FirstChunkTimeoutError(entry.model, firstChunkTimeoutMs);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };

    const attempt = async (entry: RacePlanEntry, controller: AbortController) => {
      const canDropThinking = entry.thinkingConfig !== undefined;
      try {
        return await attemptOnce(entry, canDropThinking, controller);
      } catch (err) {
        // An invalid key is also reported as 400 INVALID_ARGUMENT; don't retry that.
        if (canDropThinking && !controller.signal.aborted && !isFatal?.(err) && isInvalidArgument?.(err)) {
          log?.(`${entry.model} rejected the request config (400); retrying once with model-default thinking`);
          return await attemptOnce(entry, false, controller);
        }
        throw err;
      }
    };

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (settled || nextIndex >= plan.length) return;
      hedgeTimer = setTimeout(() => {
        if (settled) return;
        if (running < maxParallel && nextIndex < plan.length) {
          log?.(`No response yet after ${Math.round(hedgeAfterMs / 1000)}s; also starting ${plan[nextIndex].model} in parallel`);
          launch();
        } else {
          armHedge();
        }
      }, hedgeAfterMs);
    };

    const launch = () => {
      const entry = plan[nextIndex++];
      running++;
      const controller = new AbortController();
      controllers.add(controller);
      log?.(`Trying ${entry.model}`);

      attempt(entry, controller).then(
        (winner) => {
          running--;
          if (settled) {
            controller.abort();
            return;
          }
          log?.(`${entry.model} is responding; using it`);
          finish(winner);
        },
        (err) => {
          running--;
          controllers.delete(controller);
          if (settled) return;
          errors.push({ model: entry.model, error: err });
          log?.(`${entry.model} failed: ${String(err?.message || err).slice(0, 200)}`);
          if (isFatal?.(err)) {
            finish(null);
          } else if (nextIndex < plan.length) {
            launch();
          } else if (running === 0) {
            finish(null);
          }
        },
      );
      armHedge();
    };

    if (plan.length === 0) {
      finish(null);
      return;
    }
    launch();
  });
}
