/**
 * Evaluator-only tools for reviewing, approving, and rejecting tasks.
 *
 *   wait_for_reviews  — block until at least one task is in review
 *   close_task        — approve; squash-merge the worker's branch
 *   reject_task       — requeue the task with feedback
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  abortMerge,
  commit,
  getCurrentBranch,
  getMergeConflicts,
  hasUncommittedChanges,
  mergeBranch,
  mergeSquash,
  resetHard,
} from "../../../../lib/git.js";
import {
  closeTask,
  getQueueSummary,
  getTaskById,
  getTasksByStatus,
  readQueue,
  rejectTask,
} from "../../../../lib/task-queue.js";
import type { TaskQueue } from "../../../../lib/types.js";
import { QUEUE_POLL_INTERVAL_MS } from "../../types.js";
import type { TeamAgentRuntime } from "../runtime.js";

/** Default timeout (seconds) for wait_for_reviews. */
const WAIT_DEFAULT_TIMEOUT_SEC = 120;

/** How many chars of task.result to show in the review summary. */
const RESULT_PREVIEW_CHARS = 200;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReviewTools(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  pi.registerTool({
    name: "wait_for_reviews",
    label: "Wait for Reviews",
    description:
      "Wait until at least one task is in 'review' status. Times out after timeoutSeconds (default 120) and returns current state. Call again to keep waiting.",
    parameters: Type.Object({
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Max seconds to wait. Default 120." }),
      ),
    }),
    async execute(_id, params, signal) {
      const timeoutMs = (params.timeoutSeconds ?? WAIT_DEFAULT_TIMEOUT_SEC) * 1000;
      return await handleWait(runtime, timeoutMs, signal);
    },
  });

  pi.registerTool({
    name: "close_task",
    label: "Close Task",
    description:
      "Approve and close a reviewed task. Merges the worker's branch into the target branch. If the direct merge conflicts (due to other merges since the worker started), automatically tries to update the worker's branch first and retry. Only rejects on true unresolvable conflicts. Kills the worker's tmux window on success.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the reviewed task to close" }),
    }),
    async execute(_id, params) {
      return await handleClose(runtime, params.taskId);
    },
  });

  pi.registerTool({
    name: "reject_task",
    label: "Reject Task",
    description:
      "Reject a reviewed task with feedback. Kills the worker's tmux window and requeues the task for another attempt.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the reviewed task to reject" }),
      feedback: Type.String({
        description: "Specific, actionable feedback for the next worker attempt",
      }),
    }),
    async execute(_id, params) {
      return await handleReject(runtime, params.taskId, params.feedback);
    },
  });
}

// ---------------------------------------------------------------------------
// wait_for_reviews
// ---------------------------------------------------------------------------

async function handleWait(
  runtime: TeamAgentRuntime,
  timeoutMs: number,
  signal: AbortSignal | undefined,
) {
  const pollResult = await pollUntil(
    runtime.queuePath,
    (q) => getTasksByStatus(q, "review").length > 0,
    signal,
    timeoutMs,
  );

  if (!pollResult.ok) {
    return {
      content: [{ type: "text" as const, text: `Wait ended: ${pollResult.error}` }],
      details: {},
    };
  }

  const reviewTasks = getTasksByStatus(pollResult.value, "review");
  if (reviewTasks.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No tasks in review yet (timed out). Current state:\n${getQueueSummary(pollResult.value)}`,
      }],
      details: {},
    };
  }

  const lines = ["Tasks ready for review:\n"];
  for (const t of reviewTasks) {
    lines.push(`${t.id} — ${t.title}`);
    if (t.result) {
      const preview = t.result.slice(0, RESULT_PREVIEW_CHARS);
      const ellipsis = t.result.length > RESULT_PREVIEW_CHARS ? "..." : "";
      lines.push(`  Result: ${preview}${ellipsis}`);
    }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
}

// ---------------------------------------------------------------------------
// close_task
// ---------------------------------------------------------------------------

async function handleClose(runtime: TeamAgentRuntime, taskId: string) {
  const queue = await runtime.loadQueue();
  const task = getTaskById(queue, taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);

  const workerName = task.assignedTo;

  if (task.branchName) {
    await mergeIntoTarget(runtime, queue, task.branchName, task.worktreePath, task.title);
    if (task.worktreePath) {
      await runtime.cleanupWorkerGit(task.worktreePath, task.branchName);
    }
  }

  const result = closeTask(queue, taskId, runtime.agentName);
  if (!result.ok) throw new Error(result.error);
  await runtime.saveQueue(queue);

  if (workerName) await runtime.killWorkerWindow(workerName);

  return {
    content: [{
      type: "text" as const,
      text: `Closed '${result.value.title}' after ${result.value.attempts} attempt(s). Changes merged into '${queue.targetBranch}'.`,
    }],
    details: {},
  };
}

/**
 * Squash-merge the worker's branch into the target branch.
 *
 * Strategy:
 *   1. Direct squash merge.
 *   2. If it conflicts, update the worker's branch from target and retry.
 *   3. If the update itself conflicts, abort and throw — the evaluator
 *      should reject_task with feedback so a new worker can resolve it.
 *
 * On success, commits the merge as `feat: <title>`.
 */
async function mergeIntoTarget(
  runtime: TeamAgentRuntime,
  queue: TaskQueue,
  branchName: string,
  worktreePath: string | undefined,
  title: string,
): Promise<void> {
  const repoGit = runtime.repoGit();

  const currentBranch = await getCurrentBranch(repoGit);
  if (!currentBranch.ok || currentBranch.value !== queue.targetBranch) {
    throw new Error(
      `Expected target branch '${queue.targetBranch}' but repo is on `
      + `'${currentBranch.ok ? currentBranch.value : "unknown"}'. Cannot merge.`,
    );
  }

  // Attempt 1: direct squash merge.
  const directMerge = await mergeSquash(repoGit, branchName);
  if (directMerge.ok) {
    await commitMergeIfDirty(runtime, title);
    return;
  }

  // The failed merge left the index dirty; reset before trying again.
  await resetHard(repoGit);

  if (!worktreePath) {
    throw new Error(
      `Could not merge worker branch into '${queue.targetBranch}'. `
      + `Use reject_task with feedback so a new worker can resolve the issue.`,
    );
  }

  // Attempt 2: update the worker's branch from target, then retry squash.
  const workerGit = runtime.worktreeGit(worktreePath);
  const updateResult = await mergeBranch(workerGit, queue.targetBranch);
  if (!updateResult.ok) {
    const conflicts = await getMergeConflicts(workerGit);
    await abortMerge(workerGit);
    const files = conflicts.ok ? conflicts.value.join(", ") : "unknown files";
    throw new Error(
      `Merge conflicts on: ${files}. Auto-rebase failed. `
      + `Use reject_task with feedback describing the conflicts so a new worker can resolve them.`,
    );
  }

  const retryMerge = await mergeSquash(repoGit, branchName);
  if (!retryMerge.ok) {
    await resetHard(repoGit);
    throw new Error(
      `Could not merge worker branch into '${queue.targetBranch}' even after update. `
      + `Use reject_task with feedback so a new worker can resolve the issue.`,
    );
  }

  await commitMergeIfDirty(runtime, title);
}

/** Commit a squash-merged tree if any changes are staged. */
async function commitMergeIfDirty(runtime: TeamAgentRuntime, title: string): Promise<void> {
  const repoGit = runtime.repoGit();
  const dirty = await hasUncommittedChanges(repoGit);
  if (!dirty.ok || !dirty.value) return;
  const result = await commit(repoGit, `feat: ${title}`);
  if (!result.ok) throw new Error(`Merge commit failed: ${result.error}`);
}

// ---------------------------------------------------------------------------
// reject_task
// ---------------------------------------------------------------------------

async function handleReject(runtime: TeamAgentRuntime, taskId: string, feedback: string) {
  const queue = await runtime.loadQueue();
  const task = getTaskById(queue, taskId);
  const workerName = task?.assignedTo;

  if (task?.worktreePath && task.branchName) {
    await runtime.cleanupWorkerGit(task.worktreePath, task.branchName);
  }

  const result = rejectTask(queue, taskId, feedback, runtime.agentName);
  if (!result.ok) throw new Error(result.error);
  await runtime.saveQueue(queue);

  if (workerName) await runtime.killWorkerWindow(workerName);

  return {
    content: [{
      type: "text" as const,
      text: `Rejected '${result.value.title}'. Worktree cleaned up. Requeued at top with feedback. (attempt ${result.value.attempts})`,
    }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Poll the queue file until the predicate is satisfied, the signal
 * aborts, or the timeout fires. On timeout, returns the current state
 * so the caller can make a decision rather than retrying blindly.
 */
async function pollUntil(
  queuePath: string,
  predicate: (queue: TaskQueue) => boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ok: true; value: TaskQueue } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;

  while (!signal?.aborted && Date.now() < deadline) {
    const result = await readQueue(queuePath);
    if (!result.ok) return result;
    if (predicate(result.value)) return result;
    await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
  }

  if (signal?.aborted) return { ok: false, error: "Polling aborted" };
  return await readQueue(queuePath);
}
