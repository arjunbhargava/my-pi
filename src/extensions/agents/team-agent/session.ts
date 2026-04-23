/**
 * Session-level hooks registered by every team agent.
 *
 * These give each tmux window a stable identity (title + footer),
 * a startup banner naming the role, and per-turn context injection
 * that appends the agent's role prompt and the current queue summary
 * to pi's system prompt.
 */

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
 */
export function registerSessionHooks(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  const { config, agentName, queuePath } = runtime;
  const label = displayLabel(config);

  pi.on("session_start", async (_event, ctx) => {
    const goalPreview = truncate(config.goal, TITLE_GOAL_MAX);
    ctx.ui.setTitle(`pi — ${label} | ${goalPreview}`);
    ctx.ui.setStatus("team-agent", `[${label} | team: ${config.teamId}]`);
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
}

/** Short, human-friendly role label used in the UI. */
function displayLabel(config: TeamAgentConfig): string {
  if (config.canDispatch) return "orchestrator";
  if (config.canClose) return "evaluator";
  return config.agentName;
}

/** Role description shown on the first startup notify. */
function roleLine(config: TeamAgentConfig): string {
  if (config.canDispatch) return "Role: ORCHESTRATOR (plans & dispatches)";
  if (config.canClose) return "Role: EVALUATOR (reviews & closes)";
  return `Role: WORKER (${config.agentName})`;
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
