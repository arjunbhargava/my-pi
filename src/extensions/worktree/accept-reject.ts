/**
 * Task resolution: accept (squash-merge into main) or reject (discard).
 */

import {
  commit,
  diffSummary,
  getMainBranch,
  logOneline,
  mergeSquash,
} from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { removeTask } from "./manager.js";
import { CHECKPOINT_PREFIX, type TaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the checkpoint prefix from a subject line if present.
 * "checkpoint: add auth flow" → "add auth flow"
 */
function stripCheckpointPrefix(subject: string): string {
  if (subject.startsWith(CHECKPOINT_PREFIX)) {
    return subject.slice(CHECKPOINT_PREFIX.length).trim();
  }
  return subject;
}

/**
 * Build a squash-merge commit message with the summary as the subject
 * and intermediate checkpoint commits listed as bullet points in the body
 * (matching GitHub's squash-merge format).
 */
async function buildSquashMessage(
  ctx: GitContext,
  mainBranch: string,
  task: TaskState,
  summary: string,
): Promise<string> {
  const log = await logOneline(ctx, mainBranch, task.branchName);
  if (!log.ok || log.value.length === 0) {
    return summary;
  }

  const bullets = log.value
    .reverse()
    .map((entry) => `* ${stripCheckpointPrefix(entry.subject)}`);

  return `${summary}\n\n${bullets.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Accept a task by squash-merging its branch into main.
 *
 * 1. Squash-merge the task branch into the main worktree.
 * 2. Commit with the provided summary.
 * 3. Remove the task's worktree and branch.
 *
 * Returns the SHA of the merge commit on main.
 *
 * @param mainCtx - Git context pointing at the **main** worktree.
 * @param task    - The task to accept.
 * @param summary - Commit message for the squash-merge on main.
 */
export async function acceptTask(
  mainCtx: GitContext,
  task: TaskState,
  summary: string,
): Promise<Result<string>> {
  const mainBranch = await getMainBranch(mainCtx);
  if (!mainBranch.ok) return mainBranch;

  const merge = await mergeSquash(mainCtx, task.branchName);
  if (!merge.ok) return merge;

  const fullMessage = await buildSquashMessage(mainCtx, mainBranch.value, task, summary);
  const commitResult = await commit(mainCtx, fullMessage);
  if (!commitResult.ok) return commitResult;

  const cleanup = await removeTask(mainCtx, task);
  if (!cleanup.ok) {
    // Merge succeeded but cleanup failed — warn but return the SHA
    return { ok: true, value: commitResult.value };
  }

  return { ok: true, value: commitResult.value };
}

/**
 * Reject a task by removing its worktree and branch without merging.
 *
 * @param mainCtx - Git context pointing at the **main** worktree.
 * @param task    - The task to reject.
 */
export async function rejectTask(
  mainCtx: GitContext,
  task: TaskState,
): Promise<Result<void>> {
  return removeTask(mainCtx, task);
}

/**
 * Get a summary of all changes between main and the task branch.
 * Useful for reviewing before accepting.
 *
 * @param mainCtx - Git context pointing at the **main** worktree.
 * @param task    - The task to diff.
 */
export async function getTaskDiff(
  mainCtx: GitContext,
  task: TaskState,
): Promise<Result<string>> {
  const mainBranch = await getMainBranch(mainCtx);
  if (!mainBranch.ok) return mainBranch;

  return diffSummary(mainCtx, mainBranch.value, task.branchName);
}
