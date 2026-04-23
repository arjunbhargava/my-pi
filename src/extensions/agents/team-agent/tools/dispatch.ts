/**
 * Orchestrator-only tools for dispatching and monitoring workers.
 *
 *   dispatch_task   — spawn a worker agent with an isolated worktree
 *   monitor_tasks   — wait for queue changes; auto-recover dead workers
 *   check_workers   — inspect live workers and their recent output
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { createBranch, deleteBranch, worktreeAdd } from "../../../../lib/git.js";
import {
  dispatchTask,
  getQueueSummary,
  getTasksByStatus,
  readQueue,
  recoverTask,
} from "../../../../lib/task-queue.js";
import { capturePane, createWindow, sendKeys } from "../../../../lib/tmux.js";
import type { TaskQueue } from "../../../../lib/types.js";
import { discoverAgentsFromDirs } from "../../agent-config.js";
import {
  buildWorkerCommand,
  writeAgentConfigFile,
  writeAgentLaunchScript,
} from "../../launcher.js";
import type { TeamAgentConfig } from "../../types.js";
import { QUEUE_POLL_INTERVAL_MS } from "../../types.js";
import type { TeamAgentRuntime } from "../runtime.js";

/** Default worker agent type when dispatch_task is called without one. */
const DEFAULT_WORKER_TYPE = "implementer";

/** How long to wait after spawning a worker before typing its task prompt. */
const WORKER_PROMPT_DELAY_MS = 5000;

/** Default timeouts (seconds) for the two polling tools. */
const MONITOR_DEFAULT_TIMEOUT_SEC = 120;

/** Width of captured-output lines shown in check_workers. */
const WORKER_OUTPUT_LINE_WIDTH = 120;

/** Number of recent output lines to include per worker. */
const WORKER_OUTPUT_TAIL_LINES = 5;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDispatchTools(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  pi.registerTool({
    name: "dispatch_task",
    label: "Dispatch Task",
    description:
      "Assign a queued task to a worker. Spawns an ephemeral worker agent in a new tmux window.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the queued task to dispatch" }),
      workerType: Type.Optional(
        Type.String({
          description: "Worker agent type (e.g., 'implementer', 'scout'). Defaults to 'implementer'.",
        }),
      ),
    }),
    async execute(_id, params) {
      return await handleDispatch(runtime, params.taskId, params.workerType);
    },
  });

  pi.registerTool({
    name: "monitor_tasks",
    label: "Monitor Tasks",
    description:
      "Wait for task queue changes. Also checks worker health each cycle — if a worker's tmux window has died, its task is automatically recovered and requeued. Times out after timeoutSeconds (default 120). Call again to keep monitoring.",
    parameters: Type.Object({
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Max seconds to wait. Default 120." }),
      ),
    }),
    async execute(_id, params, signal) {
      const timeoutMs = (params.timeoutSeconds ?? MONITOR_DEFAULT_TIMEOUT_SEC) * 1000;
      return await handleMonitor(runtime, timeoutMs, signal);
    },
  });

  pi.registerTool({
    name: "check_workers",
    label: "Check Workers",
    description:
      "Check the health of all active workers. Shows whether each worker's tmux window is alive and captures the last few lines of output. Automatically recovers tasks from dead workers.",
    parameters: Type.Object({}),
    async execute() {
      return await handleCheckWorkers(runtime);
    },
  });
}

// ---------------------------------------------------------------------------
// dispatch_task
// ---------------------------------------------------------------------------

async function handleDispatch(
  runtime: TeamAgentRuntime,
  taskId: string,
  workerTypeArg: string | undefined,
) {
  const { config, agentName } = runtime;
  const queue = await runtime.loadQueue();

  const workerType = workerTypeArg ?? DEFAULT_WORKER_TYPE;
  const workerDef = await findWorkerDefinition(config.agentsDirs, workerType);

  const workerName = `worker-${Date.now().toString(36)}`;
  const baseDir = path.dirname(runtime.queuePath);
  const workerBranch = `team/${config.teamId}/${workerName}`;
  const workerWorktreePath = path.join(baseDir, `team-${config.teamId}`, workerName);

  // Create the worker's isolated branch + worktree. Roll back on any failure.
  const repoGit = runtime.repoGit();
  const branchResult = await createBranch(repoGit, workerBranch, queue.targetBranch);
  if (!branchResult.ok) throw new Error(`Failed to create worker branch: ${branchResult.error}`);

  const wtResult = await worktreeAdd(repoGit, workerWorktreePath, workerBranch);
  if (!wtResult.ok) {
    await deleteBranch(repoGit, workerBranch);
    throw new Error(`Failed to create worker worktree: ${wtResult.error}`);
  }

  const dispatched = dispatchTask(queue, taskId, workerName, agentName, {
    worktreePath: workerWorktreePath,
    branchName: workerBranch,
  });
  if (!dispatched.ok) {
    await runtime.cleanupWorkerGit(workerWorktreePath, workerBranch);
    throw new Error(dispatched.error);
  }
  await runtime.saveQueue(queue);

  // Spawn the worker pi process in a new tmux window.
  const workerConfig: TeamAgentConfig = {
    teamId: config.teamId,
    goal: config.goal,
    agentName: workerName,
    role: "worker",
    queuePath: runtime.queuePath,
    capabilities: [],
    tmuxSession: config.tmuxSession,
    workingDir: workerWorktreePath,
    teamAgentExtensionPath: config.teamAgentExtensionPath,
    agentsDirs: config.agentsDirs,
    agentSystemPrompt: workerDef.systemPrompt,
  };

  const configPath = await writeAgentConfigFile(baseDir, config.teamId, workerName, workerConfig);
  const scriptPath = await writeAgentLaunchScript(
    baseDir, config.teamId, workerName, workerDef, configPath,
  );
  const command = buildWorkerCommand(scriptPath);
  const tmuxExec = runtime.tmuxExec();

  const windowResult = await createWindow(tmuxExec, config.tmuxSession, workerName, {
    command,
    cwd: workerWorktreePath,
  });
  if (!windowResult.ok) {
    await runtime.cleanupWorkerGit(workerWorktreePath, workerBranch);
    throw new Error(`Failed to spawn worker tmux window: ${windowResult.error}`);
  }

  // Inject the task prompt after pi has had time to start.
  const taskPrompt = [
    `You are ${workerName}. Your assigned task ID is: ${taskId}.`,
    "Use read_queue to get your task details, then do the work, then use complete_task when done.",
  ].join(" ");
  setTimeout(() => {
    void sendKeys(tmuxExec, config.tmuxSession, workerName, taskPrompt);
  }, WORKER_PROMPT_DELAY_MS);

  return {
    content: [{
      type: "text" as const,
      text: `Dispatched '${dispatched.value.title}' to ${workerName} (${workerType}). Worker has isolated worktree at '${workerWorktreePath}'.`,
    }],
    details: {},
  };
}

/** Look up a worker definition by name, throwing with a helpful error if missing. */
async function findWorkerDefinition(agentsDirs: string[], workerType: string) {
  const { agents } = await discoverAgentsFromDirs(agentsDirs);
  const match = agents.find((a) => a.role === "worker" && a.name === workerType);
  if (match) return match;

  const available = agents.filter((a) => a.role === "worker").map((a) => a.name).join(", ");
  throw new Error(`Worker type '${workerType}' not found. Available: ${available}`);
}

// ---------------------------------------------------------------------------
// monitor_tasks
// ---------------------------------------------------------------------------

async function handleMonitor(
  runtime: TeamAgentRuntime,
  timeoutMs: number,
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + timeoutMs;

  const initial = await runtime.loadQueue();
  let lastCounts = snapshotCounts(initial);

  while (!signal?.aborted && Date.now() < deadline) {
    const queue = await runtime.loadQueue();

    const recovered = await recoverDeadWorkers(runtime, queue);
    if (recovered > 0) {
      await runtime.saveQueue(queue);
      return {
        content: [{
          type: "text" as const,
          text: `Recovered ${recovered} task(s) from dead workers.\n\n${getQueueSummary(queue)}`,
        }],
        details: {},
      };
    }

    const counts = snapshotCounts(queue);
    if (!countsEqual(counts, lastCounts)) {
      return {
        content: [{ type: "text" as const, text: getQueueSummary(queue) }],
        details: {},
      };
    }
    lastCounts = counts;

    await sleep(QUEUE_POLL_INTERVAL_MS);
  }

  // Timeout: return the current state (read without throwing) so the
  // caller can decide what to do next.
  const final = await readQueue(runtime.queuePath);
  const summary = final.ok ? getQueueSummary(final.value) : "(queue read failed)";
  return {
    content: [{
      type: "text" as const,
      text: `Monitor timed out after ${Math.round(timeoutMs / 1000)}s. Current state:\n${summary}`,
    }],
    details: {},
  };
}

interface QueueCounts {
  queued: number;
  active: number;
  review: number;
  closed: number;
}

function snapshotCounts(queue: TaskQueue): QueueCounts {
  return {
    queued: getTasksByStatus(queue, "queued").length,
    active: getTasksByStatus(queue, "active").length,
    review: getTasksByStatus(queue, "review").length,
    closed: queue.closed.length,
  };
}

function countsEqual(a: QueueCounts, b: QueueCounts): boolean {
  return a.queued === b.queued
    && a.active === b.active
    && a.review === b.review
    && a.closed === b.closed;
}

// ---------------------------------------------------------------------------
// check_workers
// ---------------------------------------------------------------------------

async function handleCheckWorkers(runtime: TeamAgentRuntime) {
  const queue = await runtime.loadQueue();
  const activeTasks = getTasksByStatus(queue, "active");

  if (activeTasks.length === 0) {
    return { content: [{ type: "text" as const, text: "No active tasks." }], details: {} };
  }

  const tmuxExec = runtime.tmuxExec();
  const lines: string[] = [`Active workers (${activeTasks.length}):\n`];
  let recovered = 0;

  for (const task of activeTasks) {
    const workerName = task.assignedTo ?? "(unknown)";
    const alive = task.assignedTo ? await runtime.isWorkerAlive(task.assignedTo) : false;

    if (!alive) {
      lines.push(`  ✗ ${workerName} — DEAD (window gone)`);
      lines.push(`    Task: ${task.title} (${task.id})`);
      if (task.assignedTo) {
        if (task.worktreePath && task.branchName) {
          await runtime.cleanupWorkerGit(task.worktreePath, task.branchName);
        }
        recoverTask(
          queue, task.id,
          `Worker '${task.assignedTo}' exited without completing.`,
          runtime.agentName,
        );
        recovered++;
        lines.push(`    → Recovered, worktree cleaned up, and requeued`);
      }
    } else {
      lines.push(`  ✓ ${workerName} — ALIVE`);
      lines.push(`    Task: ${task.title} (${task.id})`);

      const paneResult = await capturePane(tmuxExec, runtime.config.tmuxSession, task.assignedTo!);
      if (paneResult.ok) {
        const tail = paneResult.value
          .split("\n")
          .filter((l) => l.trim())
          .slice(-WORKER_OUTPUT_TAIL_LINES);
        if (tail.length > 0) {
          lines.push(`    Recent output:`);
          for (const line of tail) lines.push(`      ${line.slice(0, WORKER_OUTPUT_LINE_WIDTH)}`);
        } else {
          lines.push(`    (no recent output)`);
        }
      }
    }
    lines.push("");
  }

  if (recovered > 0) {
    await runtime.saveQueue(queue);
    lines.push(`Recovered ${recovered} task(s) from dead workers. They are requeued at the top.`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Scan active tasks for dead workers; recover each one and clean up its
 * git state. Mutates the queue in place — the caller must saveQueue.
 * Returns the number of tasks recovered.
 */
async function recoverDeadWorkers(runtime: TeamAgentRuntime, queue: TaskQueue): Promise<number> {
  const activeTasks = getTasksByStatus(queue, "active");
  let recovered = 0;

  for (const task of activeTasks) {
    if (!task.assignedTo) continue;
    const alive = await runtime.isWorkerAlive(task.assignedTo);
    if (alive) continue;

    if (task.worktreePath && task.branchName) {
      await runtime.cleanupWorkerGit(task.worktreePath, task.branchName);
    }
    recoverTask(
      queue, task.id,
      `Worker '${task.assignedTo}' exited without completing. Window no longer exists.`,
      runtime.agentName,
    );
    recovered++;
  }

  return recovered;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
