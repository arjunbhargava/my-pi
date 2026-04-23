/**
 * Wait for task-queue changes without busy-polling.
 *
 * Uses {@link fs.watch} on the queue's parent directory (not the file
 * itself) so atomic writes — which {@link writeQueue} performs as
 * tmp-file + rename — fire reliably across platforms. On each wake,
 * the caller's handler decides whether to stop or keep waiting.
 *
 * The wake sources are:
 *   - filesystem events on the queue file
 *   - an optional heartbeat timer (for work that isn't triggered by
 *     queue writes, e.g. reaping dead workers)
 *   - the caller's abort signal
 *   - the deadline derived from timeoutMs
 *
 * The wait loop is structured so that any wake delivered *during* a
 * handler invocation is preserved: the next `wakePromise` is always
 * armed before the handler runs, so a resolution that lands mid-
 * handler simply makes the following `await` a no-op. No events are
 * coalesced away, and no iteration can hang on a silently-dropped wake.
 */

import { watch, type FSWatcher } from "node:fs";
import * as path from "node:path";

import { readQueue } from "../../../lib/task-queue.js";
import type { TaskQueue } from "../../../lib/types.js";

/** Signal from the handler: stop waiting (`done`) or keep waiting (`continue`). */
export type HandlerResult = "done" | "continue";

export interface WatchOptions {
  signal?: AbortSignal;
  /** Maximum time to wait overall. */
  timeoutMs: number;
  /**
   * Also re-invoke the handler at least this often, even without a
   * filesystem event. Useful for fallback work (e.g. dead-worker
   * detection) that doesn't correspond to a queue write.
   */
  heartbeatMs?: number;
}

export type WatchOutcome = "done" | "timeout" | "aborted";

/**
 * Block until the handler returns "done", the signal aborts, or the
 * timeout elapses. If the queue file is temporarily unreadable (e.g.
 * mid-rename), that iteration is silently skipped — the next wake
 * will retry.
 */
export async function watchQueueUntil(
  queuePath: string,
  handler: (queue: TaskQueue) => Promise<HandlerResult>,
  options: WatchOptions,
): Promise<WatchOutcome> {
  const dir = path.dirname(queuePath);
  const filename = path.basename(queuePath);
  const deadline = Date.now() + options.timeoutMs;

  // The wake primitive: a resolver that any wake source can call.
  // Reset to null after firing so stale wakes are no-ops.
  let resolveWake: (() => void) | null = null;
  const wake = (): void => {
    const resolver = resolveWake;
    resolveWake = null;
    resolver?.();
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (name === filename) wake();
    });
  } catch {
    // Can't watch — fail open by treating every cycle as a heartbeat.
    // Polling behavior falls back to whatever heartbeatMs / deadline is set.
    return runPolling(queuePath, handler, options);
  }
  watcher.on("error", wake);

  const heartbeat = options.heartbeatMs != null
    ? setInterval(wake, options.heartbeatMs)
    : null;

  const onAbort = wake;
  options.signal?.addEventListener("abort", onAbort);

  const deadlineTimer = setTimeout(wake, options.timeoutMs);

  try {
    while (!options.signal?.aborted && Date.now() < deadline) {
      // Arm the next wake BEFORE invoking the handler. A wake that
      // arrives while the handler is running resolves this promise,
      // and the later `await` returns immediately.
      const wakePromise = new Promise<void>((resolve) => {
        resolveWake = resolve;
      });

      const outcome = await evaluate(queuePath, handler);
      if (outcome === "done") return "done";

      await wakePromise;
    }

    return options.signal?.aborted ? "aborted" : "timeout";
  } finally {
    clearTimeout(deadlineTimer);
    if (heartbeat !== null) clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", onAbort);
    watcher.close();
  }
}

/** One handler evaluation. "skip" means the file was unreadable. */
async function evaluate(
  queuePath: string,
  handler: (queue: TaskQueue) => Promise<HandlerResult>,
): Promise<HandlerResult | "skip"> {
  const result = await readQueue(queuePath);
  if (!result.ok) return "skip";
  return handler(result.value);
}

/**
 * Polling fallback used when {@link fs.watch} can't be started.
 * Wakes only on heartbeat, abort, or deadline — never on fs events.
 */
async function runPolling(
  queuePath: string,
  handler: (queue: TaskQueue) => Promise<HandlerResult>,
  options: WatchOptions,
): Promise<WatchOutcome> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.heartbeatMs ?? 3000;

  while (!options.signal?.aborted && Date.now() < deadline) {
    const outcome = await evaluate(queuePath, handler);
    if (outcome === "done") return "done";
    await sleep(Math.min(interval, deadline - Date.now()), options.signal);
  }
  return options.signal?.aborted ? "aborted" : "timeout";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
