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
import { summarizePrompt } from "./checkpoint.js";
import { removeTask } from "./manager.js";
import type { TaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a squash-merge commit message with the summary as the subject,
 * checkpoint history as bullet points, and each checkpoint's full
 * description preserved in the body for traceability.
 */
function buildSquashMessage(task: TaskState, summary: string): string {
  if (task.checkpoints.length === 0) {
    return summary;
  }

  const sections: string[] = [summary, ""];

  // Bullet list of checkpoint subjects (like GitHub squash-merge format)
  const bullets = task.checkpoints.map((cp) => {
    const shortSha = cp.sha.slice(0, 8);
    const subject = summarizePrompt(cp.description);
    return `* ${shortSha} — ${subject}`;
  });
  sections.push(bullets.join("\n"), "");

  // Full checkpoint details for traceability
  sections.push("Checkpoints:");
  for (const cp of task.checkpoints) {
    const date = new Date(cp.timestamp).toISOString();
    sections.push(`  ${cp.sha.slice(0, 8)} (${date})`);
    sections.push(`  ${cp.description.trim()}`);
    sections.push("");
  }

  return sections.join("\n").trimEnd();
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

  const fullMessage = buildSquashMessage(task, summary);
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
