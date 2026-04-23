/**
 * Shared type definitions used across all modules.
 * Contains execution types, result types, git data shapes, and task queue shapes.
 * No logic — only type declarations and constants.
 */

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Return value from a shell command execution. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/**
 * Generic shell executor signature.
 * Matches the shape of `pi.exec` so the extension layer can inject it
 * without the library modules depending on pi directly.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/**
 * Everything a git operation needs: an executor and a working directory.
 * The `cwd` is passed as `git -C <cwd>` so it works regardless of
 * where the parent process is running.
 */
export interface GitContext {
  exec: ExecFn;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated union for operations that can fail in expected ways. */
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Git data shapes
// ---------------------------------------------------------------------------

/** Parsed status of a single file from `git status --porcelain`. */
export interface FileStatus {
  /** Relative path within the repository. */
  path: string;
  /** Single-character status in the index (staged area). */
  indexStatus: string;
  /** Single-character status in the working tree. */
  workingTreeStatus: string;
}

/** Parsed entry from `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name (without `refs/heads/` prefix), or null if detached. */
  branch: string | null;
  /** HEAD commit SHA. */
  head: string;
  /** True for the main worktree (where `.git` directory lives). */
  isMainWorktree: boolean;
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/**
 * Generic execution context: an executor and a working directory.
 * Shared by git wrappers, tmux wrappers, and any other CLI tool.
 */
export interface ExecContext {
  exec: ExecFn;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Task queue data shapes
// ---------------------------------------------------------------------------

/** Lifecycle states for a task in the queue. */
export type TaskStatus = "queued" | "active" | "review" | "closed";

/**
 * A single unit of work in the task queue.
 *
 * Tasks flow: queued → active → review → closed.
 * Rejected tasks are reinserted at the top of the queue with feedback.
 */
export interface Task {
  /** Short unique identifier (hex string). */
  id: string;
  /** One-line summary of the task. */
  title: string;
  /** Detailed description of what needs to be done. */
  description: string;
  /** Current lifecycle status. */
  status: TaskStatus;
  /** Who added this task ("orchestrator", "worker-3", etc.). */
  addedBy: string;
  /** Worker instance name when status is "active". */
  assignedTo?: string;
  /** Absolute path to the worker's git worktree (set on dispatch). */
  worktreePath?: string;
  /** Git branch name for the worker's worktree (set on dispatch). */
  branchName?: string;
  /** Worker output posted on completion (before review). */
  result?: string;
  /** Evaluator feedback attached on rejection. */
  feedback?: string;
  /** Number of times this task has been attempted. Incremented on each dispatch. */
  attempts: number;
  /** Unix timestamp (ms) when the task was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the last status change. */
  updatedAt: number;
}

/**
 * Minimal record of a closed task, kept for history without bloating the queue.
 * Full task details are discarded on close to stay token-efficient.
 */
export interface ClosedTask {
  /** Task ID (matches the original {@link Task.id}). */
  id: string;
  /** One-line summary (copied from the original task). */
  title: string;
  /** Who closed this task. */
  closedBy: string;
  /** How many attempts it took before closure. */
  attempts: number;
  /** Unix timestamp (ms) when the task was closed. */
  closedAt: number;
}

/** A single entry in the team activity log. */
export interface LogEntry {
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Agent that performed the action. */
  agent: string;
  /** Human-readable description of what happened. */
  action: string;
}

/**
 * The full task queue for one team session.
 *
 * Persisted as a single JSON file per team. The `tasks` array holds
 * only active work (queued/active/review). Completed tasks are archived
 * to `closed` as minimal summaries. The `log` is capped to keep the
 * file lean as the team grows.
 */
export interface TaskQueue {
  /** Unique team session identifier. */
  teamId: string;
  /** High-level objective for this team session. */
  goal: string;
  /** Branch that completed work merges into. Detected at team creation. */
  targetBranch: string;
  /** tmux session name hosting this team. Used by rediscovery to pair a queue with its live tmux session on pi restart. */
  tmuxSession: string;
  /** Unix timestamp (ms) when the team was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the last queue mutation. */
  updatedAt: number;
  /** Active tasks (queued, active, review). Ordered: index 0 is next to dispatch. */
  tasks: Task[];
  /** Archived closed tasks (minimal summaries). */
  closed: ClosedTask[];
  /** Capped activity log for debugging. Newest last. */
  log: LogEntry[];
}
