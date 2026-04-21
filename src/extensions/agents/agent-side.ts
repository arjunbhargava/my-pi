/**
 * Agent-side extension loaded by spawned pi agent processes.
 *
 * Reads configuration from the PI_TEAM_AGENT_CONFIG environment variable
 * to determine which team this agent belongs to, its role, and which
 * tools to register. This is the only file in the agent-side context
 * that imports from `@mariozechner/pi-coding-agent`.
 *
 * Tool registration is role-aware:
 *   - All agents: read_queue, complete_task, add_task
 *   - Orchestrator: dispatch_task, monitor_tasks
 *   - Evaluator: wait_for_reviews, close_task, reject_task
 *
 * Every agent gets clear UI indicators: terminal title, footer status,
 * and a startup banner so the user always knows which agent they're
 * looking at in a tmux window.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { discoverAgentsFromDirs } from "./agent-config.js";
import { buildWorkerCommand, writeAgentConfigFile, writeAgentLaunchScript } from "./launcher.js";
import { capturePane, createWindow, killWindow, listWindows, sendKeys } from "../../lib/tmux.js";
import {
  addTask,
  closeTask,
  completeTask,
  dispatchTask,
  getQueueSummary,
  getTaskById,
  getTasksByStatus,
  readQueue,
  recoverTask,
  rejectTask,
  writeQueue,
} from "../../lib/task-queue.js";
import type { ExecContext, TaskQueue } from "../../lib/types.js";
import {
  AGENT_CONFIG_ENV_VAR,
  type AgentSideConfig,
  QUEUE_POLL_INTERVAL_MS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout (ms) for blocking poll tools. */
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Load agent config. The env var may contain:
 *   - A file path ending in .json → read and parse the file
 *   - Inline JSON (legacy/testing fallback)
 */
function loadConfig(): AgentSideConfig | null {
  const configRef = process.env[AGENT_CONFIG_ENV_VAR];
  if (!configRef) return null;

  // File path: read from disk
  if (configRef.endsWith(".json")) {
    try {
      const raw = readFileSync(configRef, "utf-8");
      return JSON.parse(raw) as AgentSideConfig;
    } catch {
      return null;
    }
  }

  // Inline JSON fallback
  try {
    return JSON.parse(configRef) as AgentSideConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/** Format role for display: ORCHESTRATOR, EVALUATOR, WORKER */
function roleLabel(role: string): string {
  return role === "permanent" ? "PERMANENT" : "WORKER";
}

/** Short label like "orchestrator" or "worker-abc" */
function agentLabel(config: AgentSideConfig): string {
  const roleTag = config.canDispatch ? "orchestrator"
    : config.canClose ? "evaluator"
    : config.agentName;
  return roleTag;
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

/**
 * Poll the queue file until a predicate is satisfied, signal aborts, or timeout.
 * On timeout, returns the current state (so the LLM can re-assess) rather than an error.
 */
async function pollUntil(
  queuePath: string,
  predicate: (q: TaskQueue) => boolean,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<{ ok: true; value: TaskQueue } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    const result = await readQueue(queuePath);
    if (!result.ok) return result;
    if (predicate(result.value)) return result;
    await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
  }
  if (signal?.aborted) return { ok: false, error: "Polling aborted" };
  // Timeout: return current state so the agent can decide what to do
  return await readQueue(queuePath);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentSideExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  if (!config) return; // not running as a team agent — silently skip

  const { agentName, queuePath, canDispatch, canClose } = config;
  const label = agentLabel(config);

  // -----------------------------------------------------------------------
  // UI indicators — always visible so the user knows which agent this is
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Terminal title: "pi — orchestrator | build auth system"
    const goalPreview = config.goal.length > 40
      ? config.goal.slice(0, 40) + "…"
      : config.goal;
    ctx.ui.setTitle(`pi — ${label} | ${goalPreview}`);

    // Footer status: [orchestrator | team: abc123]
    ctx.ui.setStatus("team-agent", `[${label} | team: ${config.teamId}]`);

    // Startup banner
    const roleLine = config.canDispatch ? "Role: ORCHESTRATOR (plans & dispatches)"
      : config.canClose ? "Role: EVALUATOR (reviews & closes)"
      : `Role: WORKER (${roleLabel(config.role)})`;

    ctx.ui.notify(
      [
        `━━━ Team Agent: ${agentName} ━━━`,
        roleLine,
        `Team: ${config.goal}`,
        `Queue: ${queuePath}`,
      ].join("\n"),
      "info",
    );
  });

  // Inject team context (and agent system prompt) into every agent turn.
  // We inject via before_agent_start instead of --append-system-prompt
  // because that flag combined with extensions causes pi to hang in -p mode.
  pi.on("before_agent_start", async (event) => {
    const queueResult = await readQueue(queuePath);
    const summary = queueResult.ok ? getQueueSummary(queueResult.value) : "(queue unavailable)";

    const contextParts = [
      `You are agent "${agentName}" in a multi-agent team.`,
      `Queue file: ${queuePath}`,
      "",
      summary,
    ];

    // Append the agent's system prompt to the system prompt directly
    // instead of using --append-system-prompt CLI flag.
    let systemPrompt = event.systemPrompt ?? "";
    if (config.agentSystemPrompt) {
      systemPrompt += "\n\n" + config.agentSystemPrompt;
    }

    return {
      systemPrompt,
      message: {
        customType: "team-context",
        content: contextParts.join("\n"),
        display: false,
      },
    };
  });

  // -- Tools available to ALL agents ----------------------------------------

  pi.registerTool({
    name: "read_queue",
    label: "Read Queue",
    description: "Read the current task queue state. Returns a summary of all tasks by status, or details of a specific task.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Specific task ID to read in detail. Omit for summary." })),
    }),
    async execute(_id, params) {
      const result = await readQueue(queuePath);
      if (!result.ok) throw new Error(result.error);
      const queue = result.value;

      if (params.taskId) {
        const task = getTaskById(queue, params.taskId);
        if (!task) throw new Error(`Task '${params.taskId}' not found`);
        const lines = [
          `Task: ${task.title} (${task.id})`,
          `Status: ${task.status}`,
          `Attempts: ${task.attempts}`,
          `Description:\n${task.description}`,
        ];
        if (task.result) lines.push(`\nPrevious result:\n${task.result}`);
        if (task.feedback) lines.push(`\nEvaluator feedback:\n${task.feedback}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      }

      return { content: [{ type: "text", text: getQueueSummary(queue) }], details: {} };
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
      const result = await readQueue(queuePath);
      if (!result.ok) throw new Error(result.error);
      const queue = result.value;
      const task = addTask(queue, params.title, params.description, agentName);
      const writeResult = await writeQueue(queuePath, queue);
      if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);
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
      result: Type.String({ description: "Summary of what was done — be specific about files changed and why" }),
    }),
    async execute(_id, params) {
      const qResult = await readQueue(queuePath);
      if (!qResult.ok) throw new Error(qResult.error);
      const queue = qResult.value;
      const taskResult = completeTask(queue, params.taskId, params.result, agentName);
      if (!taskResult.ok) throw new Error(taskResult.error);
      const writeResult = await writeQueue(queuePath, queue);
      if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);
      return {
        content: [{ type: "text", text: `Task '${taskResult.value.title}' marked for review.` }],
        details: {},
      };
    },
  });

  // -- Orchestrator-only tools -----------------------------------------------

  if (canDispatch) {
    // Capture config fields for closures (avoids null-check issues)
    const tmuxSession = config.tmuxSession;
    const workingDir = config.workingDir;

    /** Helper: build an ExecContext from pi.exec for tmux operations. */
    function tmuxExecCtx(): ExecContext {
      return {
        exec: (cmd: string, args: string[], opts?: { timeout?: number }) => pi.exec(cmd, args, opts),
        cwd: workingDir,
      };
    }

    /** Helper: check if a worker's tmux window still exists. */
    async function isWorkerWindowAlive(workerName: string): Promise<boolean> {
      const windowsResult = await listWindows(tmuxExecCtx(), tmuxSession);
      if (!windowsResult.ok) return false;
      return windowsResult.value.some((w) => w.name === workerName);
    }

    pi.registerTool({
      name: "dispatch_task",
      label: "Dispatch Task",
      description: "Assign a queued task to a worker. Spawns an ephemeral worker agent in a new tmux window.",
      parameters: Type.Object({
        taskId: Type.String({ description: "ID of the queued task to dispatch" }),
        workerType: Type.Optional(Type.String({ description: "Worker agent type (e.g., 'implementer', 'scout'). Defaults to 'implementer'." })),
      }),
      async execute(_id, params) {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;

        const workerName = `worker-${Date.now().toString(36)}`;
        const result = dispatchTask(queue, params.taskId, workerName, agentName);
        if (!result.ok) throw new Error(result.error);

        const writeResult = await writeQueue(queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);

        // Find the worker definition
        const workerType = params.workerType ?? "implementer";
        const { agents } = await discoverAgentsFromDirs(config.agentsDirs);
        const workerDef = agents.find((a) => a.role === "worker" && a.name === workerType);
        if (!workerDef) throw new Error(`Worker type '${workerType}' not found. Available: ${agents.filter(a => a.role === "worker").map(a => a.name).join(", ")}`);

        // Build the worker config, launch script, and command
        const workerConfig: AgentSideConfig = {
          teamId: config.teamId,
          goal: config.goal,
          agentName: workerName,
          role: "worker",
          queuePath,
          canDispatch: false,
          canClose: false,
          tmuxSession: config.tmuxSession,
          workingDir: config.workingDir,
          agentSideExtensionPath: config.agentSideExtensionPath,
          agentsDirs: config.agentsDirs,
          agentSystemPrompt: workerDef.systemPrompt,
        };

        const pathMod = await import("node:path");
        const baseDir = pathMod.dirname(queuePath);
        const configPath = await writeAgentConfigFile(baseDir, config.teamId, workerName, workerConfig);

        const scriptPath = await writeAgentLaunchScript(
          baseDir, config.teamId, workerName, workerDef,
          configPath, config.agentSideExtensionPath,
        );
        const command = buildWorkerCommand(scriptPath);

        // Spawn as interactive pi session
        const ctx = tmuxExecCtx();
        const windowResult = await createWindow(ctx, tmuxSession, workerName, {
          command,
          cwd: workingDir,
        });

        if (!windowResult.ok) {
          throw new Error(`Failed to spawn worker tmux window: ${windowResult.error}`);
        }

        // Inject the task prompt after pi has time to start
        const taskPrompt = [
          `You are ${workerName}. Your assigned task ID is: ${params.taskId}.`,
          "Use read_queue to get your task details, then do the work, then use complete_task when done.",
        ].join(" ");

        setTimeout(async () => {
          await sendKeys(ctx, tmuxSession, workerName, taskPrompt);
        }, 5000);

        return {
          content: [{
            type: "text",
            text: `Dispatched '${result.value.title}' to ${workerName} (${workerType}). Interactive worker running in tmux window '${workerName}'.`,
          }],
          details: {},
        };
      },
    });

    /**
     * Helper: recover any active tasks whose worker windows have died.
     * Returns the number of tasks recovered.
     */
    async function recoverDeadWorkers(queue: TaskQueue): Promise<number> {
      const activeTasks = getTasksByStatus(queue, "active");
      let recovered = 0;
      for (const task of activeTasks) {
        if (!task.assignedTo) continue;
        const alive = await isWorkerWindowAlive(task.assignedTo);
        if (!alive) {
          recoverTask(queue, task.id, `Worker '${task.assignedTo}' exited without completing. Window no longer exists.`, agentName);
          recovered++;
        }
      }
      return recovered;
    }

    pi.registerTool({
      name: "monitor_tasks",
      label: "Monitor Tasks",
      description: "Wait for task queue changes. Also checks worker health each cycle — if a worker's tmux window has died, its task is automatically recovered and requeued. Times out after timeoutSeconds (default 120). Call again to keep monitoring.",
      parameters: Type.Object({
        timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait. Default 120." })),
      }),
      async execute(_id, params, signal) {
        const timeoutMs = (params.timeoutSeconds ?? 120) * 1000;
        const deadline = Date.now() + timeoutMs;

        const beforeResult = await readQueue(queuePath);
        if (!beforeResult.ok) throw new Error(beforeResult.error);

        let lastActiveCount = getTasksByStatus(beforeResult.value, "active").length;
        let lastReviewCount = getTasksByStatus(beforeResult.value, "review").length;
        let lastQueuedCount = getTasksByStatus(beforeResult.value, "queued").length;
        let lastClosedCount = beforeResult.value.closed.length;

        while (!signal?.aborted && Date.now() < deadline) {
          // Check for dead workers and recover their tasks
          const qResult = await readQueue(queuePath);
          if (qResult.ok) {
            const recovered = await recoverDeadWorkers(qResult.value);
            if (recovered > 0) {
              await writeQueue(queuePath, qResult.value);
              // Dead workers found — return immediately so orchestrator can re-dispatch
              return {
                content: [{ type: "text", text: `Recovered ${recovered} task(s) from dead workers.\n\n${getQueueSummary(qResult.value)}` }],
                details: {},
              };
            }

            // Check for queue state changes
            const activeNow = getTasksByStatus(qResult.value, "active").length;
            const reviewNow = getTasksByStatus(qResult.value, "review").length;
            const queuedNow = getTasksByStatus(qResult.value, "queued").length;
            const closedNow = qResult.value.closed.length;

            if (activeNow !== lastActiveCount || reviewNow !== lastReviewCount
                || queuedNow !== lastQueuedCount || closedNow !== lastClosedCount) {
              return {
                content: [{ type: "text", text: getQueueSummary(qResult.value) }],
                details: {},
              };
            }

            lastActiveCount = activeNow;
            lastReviewCount = reviewNow;
            lastQueuedCount = queuedNow;
            lastClosedCount = closedNow;
          }

          await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_INTERVAL_MS));
        }

        // Timeout — return current state
        const finalResult = await readQueue(queuePath);
        const summary = finalResult.ok ? getQueueSummary(finalResult.value) : "(queue read failed)";
        return {
          content: [{ type: "text", text: `Monitor timed out after ${(timeoutMs / 1000)}s. Current state:\n${summary}` }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "check_workers",
      label: "Check Workers",
      description: "Check the health of all active workers. Shows whether each worker's tmux window is alive and captures the last few lines of output. Automatically recovers tasks from dead workers.",
      parameters: Type.Object({}),
      async execute() {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;

        const activeTasks = getTasksByStatus(queue, "active");
        if (activeTasks.length === 0) {
          return { content: [{ type: "text", text: "No active tasks." }], details: {} };
        }

        const ctx = tmuxExecCtx();
        const lines: string[] = [`Active workers (${activeTasks.length}):\n`];
        let recovered = 0;

        for (const task of activeTasks) {
          const workerName = task.assignedTo ?? "(unknown)";
          const alive = task.assignedTo ? await isWorkerWindowAlive(task.assignedTo) : false;

          if (!alive) {
            lines.push(`  ✗ ${workerName} — DEAD (window gone)`);
            lines.push(`    Task: ${task.title} (${task.id})`);
            if (task.assignedTo) {
              recoverTask(queue, task.id, `Worker '${task.assignedTo}' exited without completing.`, agentName);
              recovered++;
              lines.push(`    → Recovered and requeued`);
            }
          } else {
            lines.push(`  ✓ ${workerName} — ALIVE`);
            lines.push(`    Task: ${task.title} (${task.id})`);

            // Capture last few lines of worker output
            const paneResult = await capturePane(ctx, config.tmuxSession, task.assignedTo!);
            if (paneResult.ok) {
              const outputLines = paneResult.value.split("\n").filter((l) => l.trim()).slice(-5);
              if (outputLines.length > 0) {
                lines.push(`    Recent output:`);
                for (const ol of outputLines) {
                  lines.push(`      ${ol.slice(0, 120)}`);
                }
              } else {
                lines.push(`    (no recent output)`);
              }
            }
          }
          lines.push("");
        }

        if (recovered > 0) {
          await writeQueue(queuePath, queue);
          lines.push(`Recovered ${recovered} task(s) from dead workers. They are requeued at the top.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      },
    });
  }

  // -- Evaluator-only tools --------------------------------------------------

  if (canClose) {
    /** Helper: kill a worker's tmux window (best-effort). */
    async function killWorkerWindow(workerName: string): Promise<void> {
      const ctx: ExecContext = {
        exec: (cmd: string, args: string[], opts?: { timeout?: number }) => pi.exec(cmd, args, opts),
        cwd: config!.workingDir,
      };
      await killWindow(ctx, config!.tmuxSession, workerName);
    }

    pi.registerTool({
      name: "wait_for_reviews",
      label: "Wait for Reviews",
      description: "Wait until at least one task is in 'review' status. Times out after timeoutSeconds (default 120) and returns current state. Call again to keep waiting.",
      parameters: Type.Object({
        timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait. Default 120." })),
      }),
      async execute(_id, params, signal) {
        const timeoutMs = (params.timeoutSeconds ?? 120) * 1000;

        const pollResult = await pollUntil(
          queuePath,
          (q) => getTasksByStatus(q, "review").length > 0,
          signal,
          timeoutMs,
        );

        if (!pollResult.ok) {
          return { content: [{ type: "text", text: `Wait ended: ${pollResult.error}` }], details: {} };
        }

        const reviewTasks = getTasksByStatus(pollResult.value, "review");
        if (reviewTasks.length === 0) {
          return {
            content: [{ type: "text", text: `No tasks in review yet (timed out). Current state:\n${getQueueSummary(pollResult.value)}` }],
            details: {},
          };
        }

        const lines = ["Tasks ready for review:\n"];
        for (const t of reviewTasks) {
          lines.push(`${t.id} — ${t.title}`);
          if (t.result) lines.push(`  Result: ${t.result.slice(0, 200)}${t.result.length > 200 ? "..." : ""}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "close_task",
      label: "Close Task",
      description: "Approve and close a reviewed task. Kills the worker's tmux window. Only the evaluator can close tasks.",
      parameters: Type.Object({
        taskId: Type.String({ description: "ID of the reviewed task to close" }),
      }),
      async execute(_id, params) {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;

        const task = getTaskById(queue, params.taskId);
        const workerName = task?.assignedTo;

        const result = closeTask(queue, params.taskId, agentName);
        if (!result.ok) throw new Error(result.error);
        const writeResult = await writeQueue(queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);

        if (workerName) await killWorkerWindow(workerName);

        return {
          content: [{ type: "text", text: `Closed '${result.value.title}' after ${result.value.attempts} attempt(s). Worker window killed.` }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "reject_task",
      label: "Reject Task",
      description: "Reject a reviewed task with feedback. Kills the worker's tmux window and requeues the task for another attempt.",
      parameters: Type.Object({
        taskId: Type.String({ description: "ID of the reviewed task to reject" }),
        feedback: Type.String({ description: "Specific, actionable feedback for the next worker attempt" }),
      }),
      async execute(_id, params) {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;

        const task = getTaskById(queue, params.taskId);
        const workerName = task?.assignedTo;

        const result = rejectTask(queue, params.taskId, params.feedback, agentName);
        if (!result.ok) throw new Error(result.error);
        const writeResult = await writeQueue(queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);

        if (workerName) await killWorkerWindow(workerName);

        return {
          content: [{
            type: "text",
            text: `Rejected '${result.value.title}'. Worker window killed. Requeued at top with feedback. (attempt ${result.value.attempts})`,
          }],
          details: {},
        };
      },
    });
  }
}


