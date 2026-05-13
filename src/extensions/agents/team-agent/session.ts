/**
 * Session-level hooks registered by every team agent.
 *
 * These give each tmux window a stable identity (title + footer),
 * a startup banner naming the role, and per-turn context injection
 * that appends the agent's role prompt and the current queue summary
 * to pi's system prompt.
 *
 * For workers, also registers a progress heartbeat that writes a
 * `.progress` file on every tool call. The orchestrator's monitor
 * heartbeat reads this to detect stalled workers.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getQueueSummary, readQueue } from "../../../lib/task-queue.js";
import type { TeamAgentConfig } from "../types.js";
import type { TeamAgentRuntime } from "./runtime.js";

/** Max characters of the goal shown in the terminal title before truncation. */
const TITLE_GOAL_MAX = 40;

/** Custom-message type used for the per-turn team-context injection. */
const TEAM_CONTEXT_MESSAGE_TYPE = "team-context";

/**
 * Register session_start and before_agent_start hooks.
 *
 * The before_agent_start hook appends `config.agentSystemPrompt` to the
 * system prompt rather than using pi's `--append-system-prompt` CLI flag,
 * because that flag hangs in -p mode when an extension is also loaded.
 *
 * For workers, also registers an after_tool_call hook that writes a
 * progress heartbeat file. The orchestrator's monitor uses this to
 * detect stalled workers without any LLM cost.
 */
export function registerSessionHooks(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { config, agentName, queuePath } = runtime;

  pi.on("session_start", async (_event, ctx) => {
    const goalPreview = truncate(config.goal, TITLE_GOAL_MAX);
    ctx.ui.setTitle(`pi — ${agentName} | ${goalPreview}`);
    ctx.ui.setStatus("team-agent", `[${agentName} | team: ${config.teamId}]`);
    ctx.ui.notify(startupBanner(agentName, config, queuePath), "info");
  });

  pi.on("before_agent_start", async (event) => {
    const queueResult = await readQueue(queuePath);
    const summary = queueResult.ok ? getQueueSummary(queueResult.value) : "(queue unavailable)";

    const teamContext = [
      `You are agent "${agentName}" in a multi-agent team.`,
      `Queue file: ${queuePath}`,
      "",
      summary,
    ].join("\n");

    const systemPrompt = config.agentSystemPrompt
      ? `${event.systemPrompt ?? ""}\n\n${config.agentSystemPrompt}`
      : event.systemPrompt;

    return {
      systemPrompt,
      message: {
        customType: TEAM_CONTEXT_MESSAGE_TYPE,
        content: teamContext,
        display: false,
      },
    };
  });

  // Workers write a progress heartbeat on every tool call so the
  // orchestrator's monitor can detect stalls without LLM cost.
  if (config.role === "worker" && config.workingDir) {
    registerProgressHeartbeat(pi, config.workingDir);
  }
}

/** Role description shown on the first startup notify. */
function roleLine(config: TeamAgentConfig): string {
  if (config.role === "worker") return `Role: WORKER (${config.agentName})`;
  const caps = config.capabilities.length > 0
    ? ` [capabilities: ${config.capabilities.join(", ")}]`
    : "";
  return `Role: PERMANENT${caps}`;
}

function startupBanner(agentName: string, config: TeamAgentConfig, queuePath: string): string {
  return [
    `━━━ Team Agent: ${agentName} ━━━`,
    roleLine(config),
    `Team: ${config.goal}`,
    `Queue: ${queuePath}`,
  ].join("\n");
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---------------------------------------------------------------------------
// Worker progress heartbeat
// ---------------------------------------------------------------------------

/** Filename written to the worker's worktree on each tool call. */
export const PROGRESS_FILENAME = ".progress";

/**
 * Register an after_tool_call hook that writes a progress heartbeat.
 * The file contains the timestamp and last tool name, allowing the
 * orchestrator's monitor to detect both stalls (no writes for N
 * minutes) and loops (same tool name repeated).
 */
function registerProgressHeartbeat(pi: ExtensionAPI, workingDir: string): void {
  const progressPath = path.join(workingDir, PROGRESS_FILENAME);

  pi.on("tool_execution_end", async (event) => {
    const entry = JSON.stringify({
      timestamp: Date.now(),
      tool: event.toolName,
    });
    try {
      writeFileSync(progressPath, entry + "\n", "utf-8");
    } catch {
      // Best-effort — don't crash the worker if the write fails.
    }
  });
}
