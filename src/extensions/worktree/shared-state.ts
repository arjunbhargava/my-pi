/**
 * Shared state file for cross-session worktree coordination.
 *
 * Stores task metadata in `<repo>-worktrees/.harness.json` so that
 * multiple pi instances can see each other's worktrees, descriptions,
 * and checkpoint history.
 *
 * Uses atomic writes (write-to-temp, then rename) to avoid corruption
 * when two instances write simultaneously. The last writer wins, which
 * is acceptable because git is the true source of truth for what
 * worktrees exist — this file is supplementary metadata.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import type { Result } from "../../lib/types.js";
import type { TaskState } from "./types.js";
import { getWorktreeBaseDir } from "./manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = ".harness.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the shared state file.
 *
 * `activeTasks` maps a pi session ID to the task ID that session
 * considers active. This allows multiple agents to each have a
 * different active worktree simultaneously.
 */
export interface SharedState {
  tasks: Record<string, TaskState>;
  activeTasks: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Get the absolute path to the shared state file for a given repo. */
export function getSharedStatePath(repoRoot: string): string {
  return path.join(getWorktreeBaseDir(repoRoot), STATE_FILENAME);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read the shared state file, returning an empty state if it doesn't exist. */
export async function readSharedState(repoRoot: string): Promise<Result<SharedState>> {
  const filePath = getSharedStatePath(repoRoot);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as SharedState;
    return { ok: true, value: parsed };
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";

    if (isNotFound) {
      return { ok: true, value: { tasks: {}, activeTasks: {} } };
    }

    return {
      ok: false,
      error: `Failed to read shared state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the shared state file atomically.
 *
 * Writes to a temporary file in the same directory, then renames it
 * into place. On POSIX systems `rename` is atomic within a filesystem,
 * so readers never see a partially written file.
 */
export async function writeSharedState(
  repoRoot: string,
  state: SharedState,
): Promise<Result<void>> {
  const filePath = getSharedStatePath(repoRoot);
  const dir = path.dirname(filePath);
  const tmpSuffix = randomBytes(4).toString("hex");
  const tmpPath = path.join(dir, `.harness-tmp-${tmpSuffix}.json`);

  try {
    await mkdir(dir, { recursive: true });
    const json = JSON.stringify(state, null, 2) + "\n";
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, filePath);
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Failed to write shared state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience mutations
// ---------------------------------------------------------------------------

/**
 * Update a task in the shared state file.
 * Reads the current file, applies the update, writes atomically.
 */
export async function updateTaskInSharedState(
  repoRoot: string,
  task: TaskState,
): Promise<Result<void>> {
  const current = await readSharedState(repoRoot);
  if (!current.ok) return current;

  current.value.tasks[task.id] = task;
  return writeSharedState(repoRoot, current.value);
}

/**
 * Remove a task from the shared state file.
 */
export async function removeTaskFromSharedState(
  repoRoot: string,
  taskId: string,
): Promise<Result<void>> {
  const current = await readSharedState(repoRoot);
  if (!current.ok) return current;

  delete current.value.tasks[taskId];

  // Also remove any active-task references pointing to this task
  for (const [sessionId, activeId] of Object.entries(current.value.activeTasks)) {
    if (activeId === taskId) {
      delete current.value.activeTasks[sessionId];
    }
  }

  return writeSharedState(repoRoot, current.value);
}

/**
 * Set which task a given session considers active.
 */
export async function setActiveTaskInSharedState(
  repoRoot: string,
  sessionId: string,
  taskId: string | null,
): Promise<Result<void>> {
  const current = await readSharedState(repoRoot);
  if (!current.ok) return current;

  if (taskId) {
    current.value.activeTasks[sessionId] = taskId;
  } else {
    delete current.value.activeTasks[sessionId];
  }

  return writeSharedState(repoRoot, current.value);
}
