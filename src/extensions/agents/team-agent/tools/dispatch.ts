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

import {
  dispatchTask,
  getQueueSummary,
  getTasksByStatus,
  readQueue,
  recoverTask,
} from "../../../../lib/task-queue.js";
import { capturePane } from "../../../../lib/tmux.js";
import type { Task, TaskQueue, TaskStatus } from "../../../../lib/types.js";
import { createWorkspace } from "../../../../lib/workspace.js";
import { discoverAgentsFromDirs } from "../../agent-config.js";
import { spawnAgentWindow } from "../../launcher.js";
import type { TeamAgentConfig } from "../../types.js";
import type { TeamAgentRuntime } from "../runtime.js";
import { watchQueueUntil } from "../watch.js";

/** Default worker agent type when dispatch_task is called without one. */
const DEFAULT_WORKER_TYPE = "implementer";

/** Default timeout (seconds) for monitor_tasks. */
const MONITOR_DEFAULT_TIMEOUT_SEC = 120;

/**
 * How often monitor_tasks re-runs dead-worker detection even without a
 * queue write. Worker death doesn't produce a filesystem event by itself
 * (tmux doesn't touch the queue), so we periodically poll tmux as a
 * safety net. Cheap: one `tmux list-windows` call.
 */
const MONITOR_HEARTBEAT_MS = 10_000;

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
  // Snapshot read (unlocked) — targetBranch is immutable after team
  // creation, so reading it outside the lock is safe. dispatchTask()
  // below re-validates the task's status under the lock.
  const snapshot = await runtime.loadQueue();

  const workerType = workerTypeArg ?? DEFAULT_WORKER_TYPE;
  const workerDef = await findWorkerDefinition(config.agentsDirs, workerType);

  const workerName = `worker-${Date.now().toString(36)}`;
  const baseDir = path.dirname(runtime.queuePath);
  const workerBranch = `team/${config.teamId}/${workerName}`;
  const workerWorktreePath = path.join(baseDir, `team-${config.teamId}`, workerName);

  const workspaceResult = await createWorkspace(runtime.repoGit(), {
    worktreePath: workerWorktreePath,
    branchName: workerBranch,
    baseBranch: snapshot.targetBranch,
  });
  if (!workspaceResult.ok) {
    throw new Error(`Failed to create worker workspace: ${workspaceResult.error}`);
  }

  let dispatched;
  try {
    dispatched = await runtime.withQueueLock((queue) => {
      const result = dispatchTask(queue, taskId, workerName, agentName, {
        worktreePath: workerWorktreePath,
        branchName: workerBranch,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
  } catch (err) {
    // Task state changed between snapshot and lock (or any other
    // mutation failure) — tear down the workspace we just created.
    await runtime.cleanupWorkerGit(workerWorktreePath, workerBranch);
    throw err;
  }

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

  const taskPrompt = [
    `You are ${workerName}. Your assigned task ID is: ${taskId}.`,
    "Use read_queue to get your task details, then do the work, then use complete_task when done.",
  ].join(" ");

  const spawnResult = await spawnAgentWindow(runtime.tmuxExec(), {
    agentDef: workerDef,
    config: workerConfig,
    initialPrompt: taskPrompt,
    baseDir,
  });
  if (!spawnResult.ok) {
    await runtime.cleanupWorkerGit(workerWorktreePath, workerBranch);
    throw new Error(`Failed to spawn worker tmux window: ${spawnResult.error}`);
  }

  return {
    content: [{
      type: "text" as const,
      text: `Dispatched '${dispatched.title}' to ${workerName} (${workerType}). Worker has isolated worktree at '${workerWorktreePath}'.`,
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
  // Baseline the current state before entering the wait so we only
  // report on actual changes that happen DURING the call.
  const initial = await runtime.loadQueue();
  let lastSignature = signQueue(initial);
  let finalMessage: string | null = null;

  const outcome = await watchQueueUntil(
    runtime.queuePath,
    async (queue) => {
      // First: reap workers whose tmux windows have vanished. Detection
      // and git cleanup happen unlocked so other agents can still
      // mutate the queue; only the final recoverTask mutation takes
      // the lock. Heartbeat gives us a wake even without a queue write.
      const dead = await detectDeadWorkers(runtime, queue);
      if (dead.length > 0) {
        await cleanupDeadWorkers(runtime, dead);
        const recovered = await applyDeadWorkerRecovery(runtime, dead);
        if (recovered > 0) {
          const fresh = await runtime.loadQueue();
          finalMessage =
            `Recovered ${recovered} task(s) from dead workers.\n\n${getQueueSummary(fresh)}`;
          return "done";
        }
      }

      // Next: diff task identities + statuses. A (complete, dispatch)
      // pair that keeps counts stable still registers as a change.
      const signature = signQueue(queue);
      if (signature !== lastSignature) {
        finalMessage = getQueueSummary(queue);
        return "done";
      }
      lastSignature = signature;
      return "continue";
    },
    { signal, timeoutMs, heartbeatMs: MONITOR_HEARTBEAT_MS },
  );

  if (outcome === "aborted") {
    return {
      content: [{ type: "text" as const, text: "Monitor aborted." }],
      details: {},
    };
  }

  if (outcome === "done" && finalMessage !== null) {
    return { content: [{ type: "text" as const, text: finalMessage }], details: {} };
  }

  // Timeout: read the latest state non-throwingly so the LLM can decide.
  const final = await readQueue(runtime.queuePath);
  const summary = final.ok ? getQueueSummary(final.value) : "(queue read failed)";
  return {
    content: [{
      type: "text" as const,
      text: `Monitor timed out after ${Math.round(timeoutMs / 1000)}s with no changes. Call monitor_tasks again to keep watching \u2014 new work can arrive at any time. Current state:\n${summary}`,
    }],
    details: {},
  };
}

/**
 * A stable string identity for a queue's observable state. Two queues
 * with the same signature are indistinguishable to a monitor caller
 * (same active tasks with same statuses, same closed count). A
 * (complete, dispatch) pair with no net count change still produces a
 * different signature because individual task statuses shift.
 */
function signQueue(queue: TaskQueue): string {
  const parts = queue.tasks
    .map((t: Task) => `${t.id}:${statusCode(t.status)}`)
    .sort();
  return `${parts.join(",")}|closed=${queue.closed.length}`;
}

function statusCode(status: TaskStatus): string {
  // Short codes keep the signature compact for long task lists.
  switch (status) {
    case "queued": return "q";
    case "active": return "a";
    case "review": return "r";
    case "closed": return "c";
  }
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
  const dead: DeadWorker[] = [];

  for (const task of activeTasks) {
    const workerName = task.assignedTo ?? "(unknown)";
    const alive = task.assignedTo ? await runtime.isWorkerAlive(task.assignedTo) : false;

    if (!alive) {
      lines.push(`  ✗ ${workerName} — DEAD (window gone)`);
      lines.push(`    Task: ${task.title} (${task.id})`);
      if (task.assignedTo) {
        dead.push({
          taskId: task.id,
          assignedTo: task.assignedTo,
          worktreePath: task.worktreePath,
          branchName: task.branchName,
        });
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

  if (dead.length > 0) {
    await cleanupDeadWorkers(runtime, dead);
    const recovered = await applyDeadWorkerRecovery(runtime, dead);
    lines.push(`Recovered ${recovered} task(s) from dead workers. They are requeued at the top.`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Identifier + worktree pointers for a worker whose tmux window has died. */
interface DeadWorker {
  taskId: string;
  assignedTo: string;
  worktreePath?: string;
  branchName?: string;
}

/**
 * Scan active tasks for dead workers. Pure detection — no mutation,
 * no cleanup. Safe to call from an unlocked snapshot of the queue.
 */
async function detectDeadWorkers(
  runtime: TeamAgentRuntime,
  queue: TaskQueue,
): Promise<DeadWorker[]> {
  const activeTasks = getTasksByStatus(queue, "active");
  const dead: DeadWorker[] = [];
  for (const task of activeTasks) {
    if (!task.assignedTo) continue;
    const alive = await runtime.isWorkerAlive(task.assignedTo);
    if (alive) continue;
    dead.push({
      taskId: task.id,
      assignedTo: task.assignedTo,
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
  }
  return dead;
}

/**
 * Clean up the git state (worktree + branch) of each dead worker.
 * Slow, so kept outside the queue lock. Called by the monitor and
 * check_workers paths before applying recovery to the queue.
 */
async function cleanupDeadWorkers(runtime: TeamAgentRuntime, dead: DeadWorker[]): Promise<void> {
  for (const w of dead) {
    if (w.worktreePath && w.branchName) {
      await runtime.cleanupWorkerGit(w.worktreePath, w.branchName);
    }
  }
}

/**
 * Apply recovery to the queue under a lock. Re-reads the queue inside
 * the lock so concurrent mutations don't get clobbered, and silently
 * skips dead workers whose tasks have since moved off `active` (e.g.
 * already recovered by a parallel caller). Returns the number of tasks
 * actually recovered.
 */
async function applyDeadWorkerRecovery(
  runtime: TeamAgentRuntime,
  dead: DeadWorker[],
): Promise<number> {
  if (dead.length === 0) return 0;
  return await runtime.withQueueLock((queue) => {
    let recovered = 0;
    for (const w of dead) {
      const result = recoverTask(
        queue,
        w.taskId,
        `Worker '${w.assignedTo}' exited without completing. Window no longer exists.`,
        runtime.agentName,
      );
      if (result.ok) recovered++;
    }
    return recovered;
  });
}

