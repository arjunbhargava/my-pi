/**
 * Task resolution: accept (squash-merge into main) or reject (discard).
 */

import {
  diffNameStatus,
  diffSummary,
  getMainBranch,
} from "../../lib/git.js";
import {
  composeCommitMessage,
  formatFileChanges,
} from "../../lib/commit-message.js";
import type { DiffFileEntry } from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { destroyWorkspace, squashMergeWorkspace } from "../../lib/workspace.js";
import { summarizePrompt } from "./checkpoint.js";
import type { TaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a squash-merge commit message combining a file-level change
 * summary with the prompts that drove those changes.
 *
 *     <summary>
 *
 *     Prompts:
 *     - add authentication middleware
 *     - fix the login endpoint
 *
 *     Changes:
 *     - add src/lib/auth.ts
 *     - modify src/lib/index.ts
 */
function buildSquashMessage(
  task: TaskState,
  summary: string,
  fileChanges: DiffFileEntry[],
): string {
  const prompts = task.checkpoints.map((cp) => summarizePrompt(cp.description));
  return composeCommitMessage(summary, [
    { heading: "Prompts", items: prompts },
    { heading: "Changes", items: formatFileChanges(fileChanges) },
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Accept a task by squash-merging its branch into main and tearing
 * down its workspace. Returns the SHA of the merge commit on main,
 * or `"no-op"` if the task produced no net changes.
 *
 * @param mainCtx - Git context pointing at the **main** worktree.
 * @param task    - The task to accept.
 * @param summary - First line of the squash commit message; a file
 *                  summary and the task's prompt history are appended.
 */
export async function acceptTask(
  mainCtx: GitContext,
  task: TaskState,
  summary: string,
): Promise<Result<string>> {
  const mainBranch = await getMainBranch(mainCtx);
  if (!mainBranch.ok) return mainBranch;

  // Capture file-level changes up front so the commit message reflects
  // the workspace contents even though the merge will overwrite them.
  const fileChanges = await diffNameStatus(mainCtx, mainBranch.value, task.branchName);
  const changes = fileChanges.ok ? fileChanges.value : [];
  const commitMessage = buildSquashMessage(task, summary, changes);

  const mergeResult = await squashMergeWorkspace(
    mainCtx,
    { worktreePath: task.worktreePath, branchName: task.branchName, baseBranch: mainBranch.value },
    { commitMessage },
  );
  if (!mergeResult.ok) return mergeResult;

  // Teardown is best-effort: merge already landed, so report success
  // regardless of whether the workspace cleanup had a hiccup.
  await destroyWorkspace(mainCtx, task);

  const merged = mergeResult.value;
  return { ok: true, value: merged.kind === "merged" ? merged.commitSha : "no-op" };
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
  return destroyWorkspace(mainCtx, task);
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
