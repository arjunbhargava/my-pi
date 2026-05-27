/**
 * Queue tools available to team agents, registered individually
 * based on the role manifest.
 *
 *   read_queue        — inspect queue state (all roles)
 *   add_task          — append a new task (orchestrator)
 *   complete_task     — mark task as ready for review (workers only)
 *   wait_for_verdict  — block until evaluator acts on worker's task (workers only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/** Per-cycle timeout for internal watch loops (ms). */
const WAIT_CYCLE_MS = 30 * 60 * 1000;

/** Heartbeat for wait_for_verdict (ms). */
const WAIT_HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------------------
// read_queue
// ---------------------------------------------------------------------------

export function registerReadQueue(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
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
      if (task.dependsOn && task.dependsOn.length > 0) {
        lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
      }
      if (task.worktreePath) lines.push(`Worktree: ${task.worktreePath}`);
      if (task.branchName) lines.push(`Branch: ${task.branchName}`);
      if (task.result) lines.push(`\nPrevious result:\n${task.result}`);
      if (task.feedback) lines.push(`\nEvaluator feedback:\n${task.feedback}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

export function registerAddTask(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { agentName } = runtime;

  pi.registerTool({
    name: "add_task",
    label: "Add Task",
    description: "Add a new task to the queue.",
    parameters: Type.Object({
      title: Type.String({ description: "One-line task summary" }),
      description: Type.String({ description: "Detailed description of what needs to be done" }),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task IDs that must be closed before this task can be dispatched",
        }),
      ),
    }),
    async execute(_id, params) {
      const task = await runtime.withQueueLock((queue) =>
        addTask(queue, params.title, params.description, agentName, {
          dependsOn: params.dependsOn,
        }),
      );
      const depNote = task.dependsOn?.length
        ? ` (depends on: ${task.dependsOn.join(", ")})`
        : "";
      return {
        content: [{ type: "text", text: `Added task '${task.title}' (${task.id})${depNote}` }],
        details: {},
      };
    },
  });
}

// ---------------------------------------------------------------------------
// complete_task (workers only)
// ---------------------------------------------------------------------------

export function registerCompleteTask(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { agentName } = runtime;

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
      const snapshot = await runtime.loadQueue();
      const snapTask = getTaskById(snapshot, params.taskId);

      // Auto-commit any uncommitted changes so the evaluator's merge
      // has a stable tree to work with.
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
}

// ---------------------------------------------------------------------------
// wait_for_verdict (workers only)
// ---------------------------------------------------------------------------

export function registerWaitForVerdict(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { agentName } = runtime;

  pi.registerTool({
    name: "wait_for_verdict",
    label: "Wait for Verdict",
    description:
      "Block until the evaluator acts on your completed task. Returns when your task is either closed (done — you can exit) or revised (feedback attached — read it and fix the issue, then complete_task again).",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of your task (currently in review)" }),
    }),
    async execute(_id, params, signal) {
      return await handleWaitForVerdict(runtime, params.taskId, agentName, signal);
    },
  });
}

async function handleWaitForVerdict(
  runtime: TeamAgentRuntime,
  taskId: string,
  agentName: string,
  signal: AbortSignal | undefined,
) {
  // Validate the task is in review and belongs to this worker.
  const initial = await runtime.loadQueue();
  const initialTask = getTaskById(initial, taskId);
  if (!initialTask) throw new Error(`Task '${taskId}' not found`);
  if (initialTask.assignedTo !== agentName) {
    throw new Error(`Task '${taskId}' is not assigned to you (assigned to '${initialTask.assignedTo}')`);
  }

  // If it's already been acted on (e.g., race between complete and verdict), return immediately.
  if (initialTask.status !== "review") {
    return describeVerdict(initialTask.status, initialTask);
  }

  let verdictStatus: string | null = null;
  let verdictTask: typeof initialTask | null = null;

  while (!signal?.aborted) {
    const outcome = await watchQueueUntil(
      runtime.queuePath,
      async (queue) => {
        const task = getTaskById(queue, taskId);
        // Task removed from active list → closed
        if (!task) {
          verdictStatus = "closed";
          return "done";
        }
        // Task moved back to active → revision requested
        if (task.status === "active") {
          verdictStatus = "revised";
          verdictTask = task;
          return "done";
        }
        // Task moved to queued → rejected (full kill, but worker
        // shouldn't still be alive — handle gracefully)
        if (task.status === "queued") {
          verdictStatus = "rejected";
          verdictTask = task;
          return "done";
        }
        return "continue";
      },
      { signal, timeoutMs: WAIT_CYCLE_MS, heartbeatMs: WAIT_HEARTBEAT_MS },
    );

    if (outcome === "done") break;
    if (outcome === "aborted") {
      return { content: [{ type: "text" as const, text: "Wait aborted." }], details: {} };
    }
    // timeout → retry silently
  }

  if (signal?.aborted) {
    return { content: [{ type: "text" as const, text: "Wait aborted." }], details: {} };
  }

  if (verdictStatus === "closed") {
    return {
      content: [{
        type: "text" as const,
        text: "Your task has been closed (approved and merged). You're done — exit gracefully.",
      }],
      details: {},
    };
  }

  if (verdictStatus === "revised" && verdictTask) {
    const feedback = verdictTask.feedback ?? "(no feedback attached)";
    return {
      content: [{
        type: "text" as const,
        text: `Revision requested. Your task is back to active status.\n\nEvaluator feedback:\n${feedback}\n\nFix the issue, then call complete_task again.`,
      }],
      details: {},
    };
  }

  if (verdictStatus === "rejected") {
    return {
      content: [{
        type: "text" as const,
        text: "Your task was fully rejected. Your worktree will be destroyed. Exiting.",
      }],
      details: {},
    };
  }

  return { content: [{ type: "text" as const, text: "Unexpected state." }], details: {} };
}

function describeVerdict(status: string, task: { feedback?: string }) {
  if (status === "active") {
    const feedback = task.feedback ?? "(no feedback)";
    return {
      content: [{
        type: "text" as const,
        text: `Your task already has a revision request.\n\nFeedback:\n${feedback}\n\nFix the issue, then call complete_task again.`,
      }],
      details: {},
    };
  }
  return {
    content: [{ type: "text" as const, text: `Task is in unexpected status '${status}'.` }],
    details: {},
  };
}
