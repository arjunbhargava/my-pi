/**
 * Shared mutable state and helpers passed to tools and commands.
 *
 * This interface decouples tool/command registration from the extension
 * entry point, allowing them to live in separate files without importing
 * from `@mariozechner/pi-coding-agent`.
 */

import type { GitContext } from "../../lib/types.js";
import type { HarnessState, TaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Notification level (mirrors pi's type without importing it)
// ---------------------------------------------------------------------------

export type NotifyLevel = "info" | "warning" | "error";

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

/**
 * Mutable bag of state and helpers that the extension entry point
 * creates and passes into tool/command registration functions.
 *
 * All fields are accessed by reference so mutations in one place
 * are visible everywhere.
 */
export interface ExtensionState {
  /** In-memory task state. Mutated in place. */
  state: HarnessState;

  /** Absolute path to the repo root, or null if not in a git repo. */
  repoRoot: string | null;

  /** Whether auto-accept is currently enabled. */
  autoAccept: boolean;

  /** Session ID for shared-state active-task tracking. */
  sessionId: string;

  /** Build a GitContext for a given working directory. */
  gitCtx(cwd: string): GitContext;

  /** Persist state to both pi session entries and the shared file. */
  persistState(): void;

  /** Remove a task from the shared state file. */
  removeFromSharedState(taskId: string): Promise<void>;

  /** Merge tasks from the shared state file and git into in-memory state. */
  refreshFromSharedState(): Promise<void>;
}

/**
 * Look up the currently active task from the extension state.
 */
export function getActiveTaskFromState(es: ExtensionState): TaskState | null {
  if (!es.state.activeTaskId) return null;
  return es.state.tasks.get(es.state.activeTaskId) ?? null;
}
