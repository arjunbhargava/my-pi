/**
 * Queue tools available to every team agent.
 *
 *   read_queue        — inspect queue state (summary or a single task)
 *   add_task          — append a new task
 *   complete_task     — mark an active task as ready for review
 *   wait_for_merges   — block until the evaluator closes more work
 *
 * complete_task also auto-commits the worker's worktree so the
 * evaluator's merge sees a stable tree.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  commit,
  diffStaged,
  hasUncommittedChanges,
  stageAll,
} from "../../../../lib/git.js";
import {
  composeCommitMessage,
  formatFileChanges,
} from "../../../../lib/commit-message.js";
import {
  addTask,
  completeTask,
  getQueueSummary,
  getTaskById,
} from "../../../../lib/task-queue.js";
import type { TeamAgentRuntime } from "../runtime.js";
import { watchQueueUntil } from "../watch.js";

/** Default timeout (seconds) for wait_for_merges. */
const WAIT_MERGES_DEFAULT_TIMEOUT_SEC = 300;

/** Heartbeat safety net for wait_for_merges (ms). */
const WAIT_MERGES_HEARTBEAT_MS = 30_000;

export function registerQueueTools(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { agentName } = runtime;

  pi.registerTool({
    name: "read_queue",
    label: "Read Queue",
    description:
      "Read the current task queue state. Returns a summary of all tasks by status, or details of a specific task.",
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({ description: "Specific task ID to read in detail. Omit for summary." }),
      ),
    }),
    async execute(_id, params) {
      const queue = await runtime.loadQueue();

      if (!params.taskId) {
        return { content: [{ type: "text", text: getQueueSummary(queue) }], details: {} };
      }

      const task = getTaskById(queue, params.taskId);
      if (!task) throw new Error(`Task '${params.taskId}' not found`);

      const lines = [
        `Task: ${task.title} (${task.id})`,
        `Status: ${task.status}`,
        `Attempts: ${task.attempts}`,
        `Description:\n${task.description}`,
      ];
      if (task.worktreePath) lines.push(`Worktree: ${task.worktreePath}`);
      if (task.branchName) lines.push(`Branch: ${task.branchName}`);
      if (task.result) lines.push(`\nPrevious result:\n${task.result}`);
      if (task.feedback) lines.push(`\nEvaluator feedback:\n${task.feedback}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "add_task",
    label: "Add Task",
    description: "Add a new task to the queue. Any agent can add tasks (e.g., discovered subtasks).",
    parameters: Type.Object({
      title: Type.String({ description: "One-line task summary" }),
      description: Type.String({ description: "Detailed description of what needs to be done" }),
    }),
    async execute(_id, params) {
      const task = await runtime.withQueueLock((queue) =>
        addTask(queue, params.title, params.description, agentName),
      );
      return {
        content: [{ type: "text", text: `Added task '${task.title}' (${task.id})` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "complete_task",
    label: "Complete Task",
    description: "Mark your assigned task as complete with a result summary. Moves it to review.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the task to complete" }),
      result: Type.String({
        description: "Summary of what was done — be specific about files changed and why",
      }),
    }),
    async execute(_id, params) {
      // Read the task to decide whether to auto-commit. Safe to read
      // unlocked: atomic rename guarantees a consistent snapshot, and
      // completeTask() below re-validates state under the lock.
      const snapshot = await runtime.loadQueue();
      const snapTask = getTaskById(snapshot, params.taskId);

      // Auto-commit any uncommitted changes so the evaluator's merge
      // has a stable tree to work with. The commit message bundles the
      // task description and the worker's result summary together with
      // the list of files this commit touches, so the worker branch's
      // git log reads as a self-contained record. Done OUTSIDE the
      // queue lock because git commits can take seconds.
      if (snapTask?.worktreePath) {
        const git = runtime.worktreeGit(snapTask.worktreePath);
        const dirty = await hasUncommittedChanges(git);
        if (dirty.ok && dirty.value) {
          await stageAll(git);
          const staged = await diffStaged(git);
          const fileItems = staged.ok ? formatFileChanges(staged.value) : [];
          const message = composeCommitMessage(`task: ${snapTask.title}`, [
            { heading: "Description", body: snapTask.description },
            { heading: "Result", body: params.result },
            { heading: "Changes", items: fileItems },
          ]);
          await commit(git, message);
        }
      }

      const task = await runtime.withQueueLock((queue) => {
        const result = completeTask(queue, params.taskId, params.result, agentName);
        if (!result.ok) throw new Error(result.error);
        return result.value;
      });
      return {
        content: [{ type: "text", text: `Task '${task.title}' marked for review.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "wait_for_merges",
    label: "Wait for Merges",
    description:
      "Block until the evaluator closes at least one more task (i.e., new work has landed on the target branch). Useful for reviewer agents that inspect the emerging codebase after each merge. Times out after timeoutSeconds (default 300); call again to keep waiting.",
    parameters: Type.Object({
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Max seconds to wait. Default 300." }),
      ),
    }),
    async execute(_id, params, signal) {
      const timeoutMs = (params.timeoutSeconds ?? WAIT_MERGES_DEFAULT_TIMEOUT_SEC) * 1000;

      // Baseline the closed count so only merges that land DURING the
      // wait count — not the ones that were already there.
      const initial = await runtime.loadQueue();
      const baselineClosed = initial.closed.length;

      const outcome = await watchQueueUntil(
        runtime.queuePath,
        async (queue) => (queue.closed.length > baselineClosed ? "done" : "continue"),
        { signal, timeoutMs, heartbeatMs: WAIT_MERGES_HEARTBEAT_MS },
      );

      if (outcome === "aborted") {
        return { content: [{ type: "text", text: "Wait aborted." }], details: {} };
      }

      const current = await runtime.loadQueue();
      const delta = current.closed.length - baselineClosed;

      if (delta === 0) {
        return {
          content: [{
            type: "text",
            text: `No merges yet (timed out after ${Math.round(timeoutMs / 1000)}s). New tasks can be added at any time \u2014 call wait_for_merges again to keep watching.\n\n${getQueueSummary(current)}`,
          }],
          details: {},
        };
      }

      const newlyClosed = current.closed.slice(-delta);
      const lines = [`${delta} new merge(s) since wait started:`];
      for (const t of newlyClosed) {
        lines.push(`- ${t.id} — ${t.title} (${t.attempts} attempt(s), closed by ${t.closedBy})`);
      }
      lines.push("", getQueueSummary(current));
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}
