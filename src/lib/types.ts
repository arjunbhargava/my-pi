/**
 * Shared type definitions used across all modules.
 * Contains git execution types, result types, and git data shapes.
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
