/**
 * Task resolution: accept (squash-merge into main) or reject (discard).
 */

import {
  commit,
  diffSummary,
  getMainBranch,
  mergeSquash,
} from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { removeTask } from "./manager.js";
import type { TaskState } from "./types.js";

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

  const commitResult = await commit(mainCtx, summary);
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
