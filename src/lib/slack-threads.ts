/**
 * Thread state persistence layer for the Slack outbound bridge.
 *
 * Maps queue entities (team, task IDs) to Slack message timestamps so
 * the bridge can post replies into the correct threads. No Slack API calls
 * here — pure read/write of a JSON sidecar file.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type { Result } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persisted mapping between queue entities and Slack message timestamps.
 * Stored as a JSON sidecar file alongside the queue file.
 */
export interface ThreadState {
  teamId: string;
  channelId: string;
  /** Timestamp of the top-level team summary message. */
  teamMessageTs: string | null;
  /** Map of taskId → Slack message timestamp (thread parent for that worker). */
  taskThreads: Record<string, string>;
  /** Map of taskId → timestamp of last reply we posted (for dedup). */
  lastPostedTs: Record<string, string>;
  /** Map of threadTs → timestamp of the newest Slack message we've seen (for inbound polling). */
  lastSeenTs: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh ThreadState with no messages tracked yet.
 *
 * @param teamId - Team session identifier.
 * @param channelId - Slack channel ID the bridge posts to.
 * @returns A new, empty ThreadState.
 */
export function createThreadState(teamId: string, channelId: string): ThreadState {
  return {
    teamId,
    channelId,
    teamMessageTs: null,
    taskThreads: {},
    lastPostedTs: {},
    lastSeenTs: {},
  };
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/**
 * Derive the sidecar state file path from the queue file path.
 *
 * Replaces the `.json` extension with `.slack.json`:
 * `.team-8f24832f.json` → `.team-8f24832f.slack.json`
 *
 * @param queuePath - Absolute or relative path to the queue JSON file.
 * @returns Path for the corresponding Slack thread-state file.
 */
export function threadStatePath(queuePath: string): string {
  if (queuePath.endsWith(".json")) {
    return queuePath.slice(0, -5) + ".slack.json";
  }
  return queuePath + ".slack.json";
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Load thread state from a JSON file.
 *
 * Returns `{ ok: false }` if the file does not exist or cannot be parsed —
 * callers should treat a missing file as "not started yet" and call
 * `createThreadState` instead.
 *
 * @param statePath - Path to the `.slack.json` sidecar file.
 * @returns The parsed ThreadState, or an error result.
 */
export async function loadThreadState(statePath: string): Promise<Result<ThreadState>> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as ThreadState;
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: `Could not read thread state from ${statePath}` };
  }
}

/**
 * Atomically persist thread state to disk.
 *
 * Writes to a temp file in the same directory, then renames into place —
 * the same pattern used by task-queue.ts to survive mid-write crashes.
 *
 * @param statePath - Destination path for the `.slack.json` sidecar file.
 * @param state - The ThreadState to write.
 * @returns Ok on success, or an error result.
 */
export async function saveThreadState(
  statePath: string,
  state: ThreadState,
): Promise<Result<void>> {
  const dir = path.dirname(statePath);
  const suffix = randomBytes(4).toString("hex");
  const tmpPath = path.join(dir, `.slack-tmp-${suffix}.json`);

  try {
    const json = JSON.stringify(state, null, 2) + "\n";
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, statePath);
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return { ok: false, error: String(err) };
  }
}
