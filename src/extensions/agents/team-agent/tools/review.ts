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
  type CommitSection,
  composeCommitMessage,
  formatFileChanges,
} from "../../../../lib/commit-message.js";
import { diffNameStatus } from "../../../../lib/git.js";
import {
  closeTask,
  getQueueSummary,
  getTaskById,
  getTasksByStatus,
  readQueue,
  rejectTask,
} from "../../../../lib/task-queue.js";
import type { Task } from "../../../../lib/types.js";
import { destroyWorkspace, squashMergeWorkspace } from "../../../../lib/workspace.js";
import type { TeamAgentRuntime } from "../runtime.js";
import { watchQueueUntil } from "../watch.js";

/** Default timeout (seconds) for wait_for_reviews. */
const WAIT_DEFAULT_TIMEOUT_SEC = 120;

/**
 * Heartbeat for wait_for_reviews. fs.watch catches every queue write,
 * so this is a conservative safety net against missed events on
 * network or virtualised filesystems — not the primary wake source.
 */
const WAIT_HEARTBEAT_MS = 30_000;

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
  let readyTasks: ReturnType<typeof getTasksByStatus> = [];

  const outcome = await watchQueueUntil(
    runtime.queuePath,
    async (queue) => {
      const tasks = getTasksByStatus(queue, "review");
      if (tasks.length > 0) {
        readyTasks = tasks;
        return "done";
      }
      return "continue";
    },
    { signal, timeoutMs, heartbeatMs: WAIT_HEARTBEAT_MS },
  );

  if (outcome === "aborted") {
    return {
      content: [{ type: "text" as const, text: "Wait aborted." }],
      details: {},
    };
  }

  if (outcome === "timeout") {
    const final = await readQueue(runtime.queuePath);
    const summary = final.ok ? getQueueSummary(final.value) : "(queue unavailable)";
    return {
      content: [{
        type: "text" as const,
        text: `No tasks in review yet (timed out). Current state:\n${summary}`,
      }],
      details: {},
    };
  }

  const lines = ["Tasks ready for review:\n"];
  for (const t of readyTasks) {
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

  if (task.branchName && task.worktreePath) {
    // Compose the squash commit message BEFORE merging: we need the
    // diff between target and the worker branch, which only exists
    // while the branch is still alive.
    const commitMessage = await buildCloseCommitMessage(runtime, queue.targetBranch, task);

    const mergeResult = await squashMergeWorkspace(
      runtime.repoGit(),
      {
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        baseBranch: queue.targetBranch,
      },
      {
        commitMessage,
        retryAfterRebase: true,
        workspaceGit: runtime.worktreeGit(task.worktreePath),
      },
    );
    if (!mergeResult.ok) {
      throw new Error(
        `${mergeResult.error} Use reject_task with feedback so a new worker can resolve the issue.`,
      );
    }

    // Stop the worker BEFORE destroying its worktree so we don't yank
    // the cwd out from under a still-live pi process.
    if (workerName) await runtime.killWorkerWindow(workerName);
    await destroyWorkspace(runtime.repoGit(), task as { worktreePath: string; branchName: string });
  } else if (workerName) {
    await runtime.killWorkerWindow(workerName);
  }

  const result = closeTask(queue, taskId, runtime.agentName);
  if (!result.ok) throw new Error(result.error);
  await runtime.saveQueue(queue);

  return {
    content: [{
      type: "text" as const,
      text: `Closed '${result.value.title}' after ${result.value.attempts} attempt(s). Changes merged into '${queue.targetBranch}'.`,
    }],
    details: {},
  };
}

/**
 * Build the squash-merge commit message for a closed task.
 *
 *     feat: <title> [(N attempts)]
 *
 *     Description:
 *     <task description>
 *
 *     Worker result:
 *     <task.result>
 *
 *     Changes:
 *     - add foo.ts
 *     - modify bar.ts
 */
async function buildCloseCommitMessage(
  runtime: TeamAgentRuntime,
  baseBranch: string,
  task: Task,
): Promise<string> {
  const diff = await diffNameStatus(runtime.repoGit(), baseBranch, task.branchName!);
  const fileItems = diff.ok ? formatFileChanges(diff.value) : [];

  const attemptsNote = task.attempts > 1 ? ` (${task.attempts} attempts)` : "";
  const subject = `feat: ${task.title}${attemptsNote}`;

  const sections: CommitSection[] = [
    { heading: "Description", body: task.description },
  ];
  if (task.result) sections.push({ heading: "Worker result", body: task.result });
  sections.push({ heading: "Changes", items: fileItems });

  return composeCommitMessage(subject, sections);
}

// ---------------------------------------------------------------------------
// reject_task
// ---------------------------------------------------------------------------

async function handleReject(runtime: TeamAgentRuntime, taskId: string, feedback: string) {
  const queue = await runtime.loadQueue();
  const task = getTaskById(queue, taskId);
  const workerName = task?.assignedTo;

  // Kill the worker first so destroying its worktree doesn't yank the
  // cwd out from under a still-running process.
  if (workerName) await runtime.killWorkerWindow(workerName);

  if (task?.worktreePath && task.branchName) {
    await destroyWorkspace(runtime.repoGit(), {
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
  }

  const result = rejectTask(queue, taskId, feedback, runtime.agentName);
  if (!result.ok) throw new Error(result.error);
  await runtime.saveQueue(queue);

  return {
    content: [{
      type: "text" as const,
      text: `Rejected '${result.value.title}'. Worktree cleaned up. Requeued at top with feedback. (attempt ${result.value.attempts})`,
    }],
    details: {},
  };
}

