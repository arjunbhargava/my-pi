/**
 * Queue tools available to every team agent.
 *
 *   read_queue     — inspect queue state (summary or a single task)
 *   add_task       — append a new task
 *   complete_task  — mark an active task as ready for review
 *
 * complete_task also auto-commits the worker's worktree so the
 * evaluator's merge sees a stable tree.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { commit, hasUncommittedChanges, stageAll } from "../../../../lib/git.js";
import {
  addTask,
  completeTask,
  getQueueSummary,
  getTaskById,
} from "../../../../lib/task-queue.js";
import type { TeamAgentRuntime } from "../runtime.js";

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
      const queue = await runtime.loadQueue();
      const task = addTask(queue, params.title, params.description, agentName);
      await runtime.saveQueue(queue);
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
      const queue = await runtime.loadQueue();
      const task = getTaskById(queue, params.taskId);

      // Auto-commit any uncommitted changes so the evaluator's merge
      // has a stable tree to work with.
      if (task?.worktreePath) {
        const git = runtime.worktreeGit(task.worktreePath);
        const dirty = await hasUncommittedChanges(git);
        if (dirty.ok && dirty.value) {
          await stageAll(git);
          await commit(git, `task: ${task.title}`);
        }
      }

      const result = completeTask(queue, params.taskId, params.result, agentName);
      if (!result.ok) throw new Error(result.error);
      await runtime.saveQueue(queue);
      return {
        content: [{ type: "text", text: `Task '${result.value.title}' marked for review.` }],
        details: {},
      };
    },
  });
}
