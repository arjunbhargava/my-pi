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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { discoverAgentsFromDirs } from "./agent-config.js";
import { buildWorkerCommand } from "./launcher.js";
import {
  addTask,
  closeTask,
  completeTask,
  dispatchTask,
  getQueueSummary,
  getTaskById,
  getTasksByStatus,
  readQueue,
  rejectTask,
  writeQueue,
} from "../../lib/task-queue.js";
import type { TaskQueue } from "../../lib/types.js";
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const raw = fs.readFileSync(configRef, "utf-8");
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

  // Inject team context into every agent turn
  pi.on("before_agent_start", async () => {
    const queueResult = await readQueue(queuePath);
    const summary = queueResult.ok ? getQueueSummary(queueResult.value) : "(queue unavailable)";

    return {
      message: {
        customType: "team-context",
        content: [
          `You are agent "${agentName}" in a multi-agent team.`,
          `Queue file: ${queuePath}`,
          "",
          summary,
        ].join("\n"),
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

        // Build the worker config and command
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
        };

        // Write config to file (avoids shell escaping issues)
        const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const configDir = pathMod.join(pathMod.dirname(queuePath), ".team-configs");
        await mkdirAsync(configDir, { recursive: true });
        const configPath = pathMod.join(configDir, `${config.teamId}-${workerName}.json`);
        await writeFileAsync(configPath, JSON.stringify(workerConfig, null, 2) + "\n", "utf-8");

        const taskPrompt = [
          `You are ${workerName}. Your assigned task ID is: ${params.taskId}.`,
          "Use read_queue to get your task details, then do the work, then use complete_task when done.",
        ].join(" ");

        const command = buildWorkerCommand(
          workerDef,
          configPath,
          config.agentSideExtensionPath,
          taskPrompt,
        );

        // Spawn tmux window directly via pi.exec
        const tmuxResult = await pi.exec("tmux", [
          "new-window", "-t", config.tmuxSession,
          "-n", workerName,
          "-c", config.workingDir,
          command,
        ]);

        if (tmuxResult.code !== 0) {
          throw new Error(`Failed to spawn worker tmux window: ${tmuxResult.stderr.trim()}`);
        }

        return {
          content: [{
            type: "text",
            text: `Dispatched '${result.value.title}' to ${workerName} (${workerType}). Worker is running in tmux window '${workerName}'.`,
          }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "monitor_tasks",
      label: "Monitor Tasks",
      description: "Wait for task queue changes (completions, rejections, new tasks). Times out after timeoutSeconds (default 120) and returns the current state. Call again to keep monitoring.",
      parameters: Type.Object({
        timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait. Default 120." })),
      }),
      async execute(_id, params, signal) {
        const timeoutMs = (params.timeoutSeconds ?? 120) * 1000;

        const beforeResult = await readQueue(queuePath);
        if (!beforeResult.ok) throw new Error(beforeResult.error);

        const activeCountBefore = getTasksByStatus(beforeResult.value, "active").length;
        const reviewCountBefore = getTasksByStatus(beforeResult.value, "review").length;
        const queuedCountBefore = getTasksByStatus(beforeResult.value, "queued").length;
        const closedCountBefore = beforeResult.value.closed.length;

        const pollResult = await pollUntil(
          queuePath,
          (q) => {
            const activeNow = getTasksByStatus(q, "active").length;
            const reviewNow = getTasksByStatus(q, "review").length;
            const queuedNow = getTasksByStatus(q, "queued").length;
            const closedNow = q.closed.length;
            return activeNow !== activeCountBefore
              || reviewNow !== reviewCountBefore
              || queuedNow !== queuedCountBefore
              || closedNow !== closedCountBefore;
          },
          signal,
          timeoutMs,
        );

        // Always return the current queue state — even on timeout/abort
        const summary = pollResult.ok ? getQueueSummary(pollResult.value) : "(queue read failed)";
        return {
          content: [{ type: "text", text: summary }],
          details: {},
        };
      },
    });
  }

  // -- Evaluator-only tools --------------------------------------------------

  if (canClose) {
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
      description: "Approve and close a reviewed task. Only the evaluator can close tasks.",
      parameters: Type.Object({
        taskId: Type.String({ description: "ID of the reviewed task to close" }),
      }),
      async execute(_id, params) {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;
        const result = closeTask(queue, params.taskId, agentName);
        if (!result.ok) throw new Error(result.error);
        const writeResult = await writeQueue(queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);
        return {
          content: [{ type: "text", text: `Closed '${result.value.title}' after ${result.value.attempts} attempt(s).` }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "reject_task",
      label: "Reject Task",
      description: "Reject a reviewed task with feedback. Requeues the task at the top of the queue for another attempt.",
      parameters: Type.Object({
        taskId: Type.String({ description: "ID of the reviewed task to reject" }),
        feedback: Type.String({ description: "Specific, actionable feedback for the next worker attempt" }),
      }),
      async execute(_id, params) {
        const qResult = await readQueue(queuePath);
        if (!qResult.ok) throw new Error(qResult.error);
        const queue = qResult.value;
        const result = rejectTask(queue, params.taskId, params.feedback, agentName);
        if (!result.ok) throw new Error(result.error);
        const writeResult = await writeQueue(queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);
        return {
          content: [{
            type: "text",
            text: `Rejected '${result.value.title}'. Requeued at top with feedback. (attempt ${result.value.attempts})`,
          }],
          details: {},
        };
      },
    });
  }
}


