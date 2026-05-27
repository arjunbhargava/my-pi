/**
 * Orchestrator-only tools for dispatching and monitoring workers.
 *
 *   dispatch_task   — spawn a worker agent with an isolated worktree
 *   monitor_tasks   — wait for queue changes; auto-recover dead workers
 *   check_workers   — inspect live workers and their recent output
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  dispatchTask,
  getQueueSummary,
  getTasksByStatus,
  recoverTask,
} from "../../../../lib/task-queue.js";
import { getHeadSha } from "../../../../lib/git.js";
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

/** Per-cycle timeout for the internal monitor loop (ms). */
const MONITOR_CYCLE_MS = 30 * 60 * 1000;

/**
 * How often monitor_tasks re-runs dead-worker detection even without a
 * queue write. Worker death doesn't produce a filesystem event by itself
 * (tmux doesn't touch the queue), so we periodically poll tmux as a
 * safety net. Cheap: one `tmux list-windows` call + stat() per worker.
 */
const MONITOR_HEARTBEAT_MS = 10_000;

/**
 * How long a worker can go without a tool call before being considered
 * stalled. 5 minutes is generous — a worker making progress will
 * typically call a tool every few seconds.
 */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

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
      "Wait for task queue changes. Also checks worker health each cycle — if a worker's tmux window has died, its task is automatically recovered and requeued. Retries internally on timeout — only returns when there is a meaningful change or the session ends.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return await handleMonitor(runtime, signal);
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

  // Record the commit SHA the workspace was branched from (audit trail).
  const headResult = await getHeadSha(runtime.worktreeGit(workerWorktreePath));
  const baseSha = headResult.ok ? headResult.value : undefined;

  let dispatched;
  try {
    dispatched = await runtime.withQueueLock((queue) => {
      const result = dispatchTask(queue, taskId, workerName, agentName, {
        worktreePath: workerWorktreePath,
        branchName: workerBranch,
        baseSha,
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
    "Use read_queue to get your task details, do the work, then complete_task when done.",
    "After completing, call wait_for_verdict to block until the evaluator reviews your work.",
    "If revised, fix the feedback and complete_task again. If closed, exit.",
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
  signal: AbortSignal | undefined,
) {
  // Baseline the current state before entering the wait so we only
  // report on actual changes that happen DURING the call.
  const initial = await runtime.loadQueue();
  let lastSignature = signQueue(initial);
  let finalMessage: string | null = null;

  // Internal retry loop: restart the watch on timeout without
  // returning to the model.
  while (!signal?.aborted) {
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
      { signal, timeoutMs: MONITOR_CYCLE_MS, heartbeatMs: MONITOR_HEARTBEAT_MS },
    );

    if (outcome === "done" && finalMessage !== null) {
      return { content: [{ type: "text" as const, text: finalMessage }], details: {} };
    }
    if (outcome === "aborted") {
      return {
        content: [{ type: "text" as const, text: "Monitor aborted." }],
        details: {},
      };
    }
    // outcome === "timeout" → loop silently
  }

  return {
    content: [{ type: "text" as const, text: "Monitor aborted." }],
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
          reason: "dead",
        });
        lines.push(`    → Recovered, worktree cleaned up, and requeued`);
      }
    } else {
      // Check tmux activity for stalls.
      const lastActivity = await runtime.getWorkerLastActivity(task.assignedTo!);
      const age = lastActivity ? Date.now() - lastActivity : 0;
      const stalled = age > STALL_THRESHOLD_MS;

      if (stalled) {
        lines.push(`  ⚠ ${workerName} — STALLED (no activity for ${Math.round(age / 60000)}m)`);
        lines.push(`    Task: ${task.title} (${task.id})`);
        if (task.assignedTo) {
          dead.push({
            taskId: task.id,
            assignedTo: task.assignedTo,
            worktreePath: task.worktreePath,
            branchName: task.branchName,
            reason: "stalled",
          });
          lines.push(`    → Recovered and requeued`);
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

/** Identifier + worktree pointers for a worker that needs recovery. */
interface DeadWorker {
  taskId: string;
  assignedTo: string;
  worktreePath?: string;
  branchName?: string;
  reason: "dead" | "stalled";
}

/**
 * Scan active tasks for dead or stalled workers.
 *
 * Detection criteria:
 *   dead    — tmux window no longer exists
 *   stalled — tmux window activity older than STALL_THRESHOLD_MS
 *
 * Pure detection — no mutation, no cleanup. Safe to call from an
 * unlocked snapshot of the queue.
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
    if (!alive) {
      dead.push({
        taskId: task.id,
        assignedTo: task.assignedTo,
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        reason: "dead",
      });
      continue;
    }

    // Check tmux activity for stalls.
    const lastActivity = await runtime.getWorkerLastActivity(task.assignedTo);
    if (lastActivity) {
      const age = Date.now() - lastActivity;
      if (age > STALL_THRESHOLD_MS) {
        dead.push({
          taskId: task.id,
          assignedTo: task.assignedTo,
          worktreePath: task.worktreePath,
          branchName: task.branchName,
          reason: "stalled",
        });
      }
    }
  }
  return dead;
}

/**
 * Clean up the git state (worktree + branch) of each dead/stalled worker.
 * For stalled workers, also kills the tmux window first since it's still
 * alive. Slow, so kept outside the queue lock. Called by the monitor and
 * check_workers paths before applying recovery to the queue.
 */
async function cleanupDeadWorkers(runtime: TeamAgentRuntime, dead: DeadWorker[]): Promise<void> {
  for (const w of dead) {
    // Stalled/looping workers have a live window — kill it first.
    if (w.reason !== "dead") {
      await runtime.killWorkerWindow(w.assignedTo);
    }
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
      const reason = reasonMessage(w);
      const result = recoverTask(
        queue,
        w.taskId,
        reason,
        runtime.agentName,
      );
      if (result.ok) recovered++;
    }
    return recovered;
  });
}

function reasonMessage(w: DeadWorker): string {
  switch (w.reason) {
    case "dead":
      return `Worker '${w.assignedTo}' exited without completing. Window no longer exists.`;
    case "stalled":
      return `Worker '${w.assignedTo}' stalled — no tmux activity for over 5 minutes.`;
  }
}

