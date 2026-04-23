/**
 * Task resolution: accept (squash-merge into main) or reject (discard).
 */

import {
  type DiffFileEntry,
  diffNameStatus,
  diffSummary,
  getMainBranch,
} from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { destroyWorkspace, squashMergeWorkspace } from "../../lib/workspace.js";
import { summarizePrompt } from "./checkpoint.js";
import type { TaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a diff status letter to a human-readable verb. */
function statusLabel(status: DiffFileEntry["status"]): string {
  const labels: Record<DiffFileEntry["status"], string> = {
    A: "add",
    M: "modify",
    D: "delete",
    R: "rename",
    C: "copy",
    T: "change type",
  };
  return labels[status] ?? status;
}

/** Format a single diff entry as a human-readable line. */
function formatDiffEntry(entry: DiffFileEntry): string {
  if (entry.renamedTo) {
    return `${statusLabel(entry.status)} ${entry.path} → ${entry.renamedTo}`;
  }
  return `${statusLabel(entry.status)} ${entry.path}`;
}

/**
 * Build a squash-merge commit message combining a file-level change
 * summary with the prompts that drove those changes.
 *
 * Format:
 * ```
 * <summary subject line>
 *
 * Changes:
 * - add src/lib/new-file.ts
 * - modify src/extensions/worktree/accept-reject.ts
 *
 * Prompts:
 * - add authentication middleware
 * - fix the login endpoint
 * ```
 */
function buildSquashMessage(
  task: TaskState,
  summary: string,
  fileChanges: DiffFileEntry[],
): string {
  const sections: string[] = [summary, ""];

  // File-level change summary
  if (fileChanges.length > 0) {
    sections.push("Changes:");
    for (const entry of fileChanges) {
      sections.push(`- ${formatDiffEntry(entry)}`);
    }
    sections.push("");
  }

  // Prompt history
  if (task.checkpoints.length > 0) {
    sections.push("Prompts:");
    for (const cp of task.checkpoints) {
      sections.push(`- ${summarizePrompt(cp.description)}`);
    }
  }

  return sections.join("\n").trimEnd();
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
