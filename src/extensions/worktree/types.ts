/**
 * Extension-specific type definitions for the worktree harness.
 * Contains task state, checkpoint records, and serialization shapes.
 * No logic — only type declarations and constants.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for the slugified portion of a branch name. */
export const MAX_SLUG_LENGTH = 48;

/** Branch prefix for all task branches. */
export const TASK_BRANCH_PREFIX = "task/";

/** Suffix appended to the repo directory name to form the worktree base. */
export const WORKTREE_DIR_SUFFIX = "-worktrees";

/** Commit message prefix for checkpoint commits. */
export const CHECKPOINT_PREFIX = "checkpoint:";

/** Custom entry type used with `pi.appendEntry` for state persistence. */
export const STATE_ENTRY_TYPE = "worktree-state";

/** Custom message type for worktree context injection. */
export const CONTEXT_MESSAGE_TYPE = "worktree-context";

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/** A single checkpoint commit created after an agent interaction. */
export interface CheckpointRecord {
  /** Full commit SHA. */
  sha: string;
  /** Human-readable description of what the agent was working on. */
  description: string;
  /** Unix timestamp (ms) when the checkpoint was created. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export type TaskStatus = "active" | "accepted" | "rejected";

/** Full state of one task. Each task maps 1:1 to a worktree and branch. */
export interface TaskState {
  /** Short unique identifier (hex string). */
  id: string;
  /** User-facing description of the feature or change. */
  description: string;
  /** Git branch name (e.g., `task/add-auth`). */
  branchName: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Ordered list of checkpoint commits on this branch. */
  checkpoints: CheckpointRecord[];
  /** Current lifecycle status. */
  status: TaskStatus;
  /** Unix timestamp (ms) when the task was created. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Harness state
// ---------------------------------------------------------------------------

/** In-memory representation of the full harness state. */
export interface HarnessState {
  tasks: Map<string, TaskState>;
  activeTaskId: string | null;
}

/** JSON-safe form of {@link HarnessState} for session persistence. */
export interface SerializedHarnessState {
  tasks: Record<string, TaskState>;
  activeTaskId: string | null;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Convert in-memory state to a JSON-safe object for `pi.appendEntry`. */
export function serializeState(state: HarnessState): SerializedHarnessState {
  const tasks: Record<string, TaskState> = {};
  for (const [id, task] of state.tasks) {
    tasks[id] = task;
  }
  return { tasks, activeTaskId: state.activeTaskId };
}

/** Reconstruct in-memory state from a persisted snapshot. */
export function deserializeState(data: SerializedHarnessState): HarnessState {
  const tasks = new Map<string, TaskState>();
  for (const [id, task] of Object.entries(data.tasks)) {
    tasks.set(id, task);
  }
  return { tasks, activeTaskId: data.activeTaskId };
}

/** Create a fresh empty state. */
export function createEmptyState(): HarnessState {
  return { tasks: new Map(), activeTaskId: null };
}
