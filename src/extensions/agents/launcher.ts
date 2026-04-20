/**
 * Team launcher: creates tmux sessions and spawns agent processes.
 *
 * Builds the pi command line for each agent, creates the tmux session
 * and windows, and initializes the task queue. This module does not
 * import from `@mariozechner/pi-coding-agent`.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";

import { createQueue, writeQueue } from "../../lib/task-queue.js";
import {
  createSession,
  createWindow,
  killSession,
  sendKeys,
  sessionExists,
} from "../../lib/tmux.js";
import type { ExecContext, Result } from "../../lib/types.js";
import type { AgentDefinition, AgentInstance, AgentSideConfig, TeamSession } from "./types.js";
import {
  AGENT_CONFIG_ENV_VAR,
  QUEUE_FILENAME_PREFIX,
  TEAM_TMUX_PREFIX,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Delay (ms) before sending initial prompts to permanent agents via tmux send-keys. */
const INITIAL_PROMPT_DELAY_MS = 5000;

/** Generate a short team ID. */
function generateTeamId(): string {
  return randomBytes(4).toString("hex");
}

/** Slugify a goal for use in tmux session names. */
function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * Build the shell command to launch a pi agent process.
 *
 * For permanent agents: `pi` (interactive mode) with the agent-side extension
 * and system prompt appended. The agent starts and immediately gets a prompt
 * injected with team context.
 *
 * For workers: `pi -p` (print mode) with a specific task prompt.
 */
export function buildAgentCommand(
  agentDef: AgentDefinition,
  agentConfig: AgentSideConfig,
  agentSideExtensionPath: string,
  opts?: { taskPrompt?: string },
): string {
  const configJson = JSON.stringify(agentConfig);
  // Shell-escape the JSON for the environment variable
  const escapedConfig = configJson.replace(/'/g, "'\\''");

  const parts: string[] = [
    `${AGENT_CONFIG_ENV_VAR}='${escapedConfig}'`,
    "pi",
    "-e", agentSideExtensionPath,
    "--append-system-prompt", agentDef.filePath,
  ];

  if (agentDef.model) {
    parts.push("--model", agentDef.model);
  }

  if (agentDef.tools && agentDef.tools.length > 0) {
    parts.push("--tools", agentDef.tools.join(","));
  }

  if (agentDef.role === "worker" && opts?.taskPrompt) {
    parts.push("-p", `"${opts.taskPrompt.replace(/"/g, '\\"')}"`);
  }

  return parts.join(" ");
}

/**
 * Build a command to launch a worker for a specific task.
 * Workers run in print mode and exit when done.
 */
export function buildWorkerCommand(
  agentDef: AgentDefinition,
  agentConfig: AgentSideConfig,
  agentSideExtensionPath: string,
  taskPrompt: string,
): string {
  return buildAgentCommand(agentDef, agentConfig, agentSideExtensionPath, { taskPrompt });
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

/**
 * Launch a new team session.
 *
 * Creates:
 *   1. A task queue file initialized with the goal
 *   2. A tmux session
 *   3. A status window showing `watch` on the queue file
 *   4. One window per permanent agent
 *
 * @param ctx                    - Execution context (for tmux commands).
 * @param goal                   - High-level objective for the team.
 * @param permanentAgents        - Definitions for permanent agents to launch.
 * @param agentSideExtensionPath - Absolute path to agent-side.ts.
 * @param baseDir                - Directory for the queue file (typically worktree base dir).
 * @param workingDir             - Working directory for agent processes.
 */
export async function launchTeam(
  ctx: ExecContext,
  goal: string,
  permanentAgents: AgentDefinition[],
  agentSideExtensionPath: string,
  baseDir: string,
  workingDir: string,
  agentsDirs: string[],
): Promise<Result<TeamSession>> {
  const teamId = generateTeamId();
  const slug = slugifyGoal(goal);
  const tmuxSession = `${TEAM_TMUX_PREFIX}${slug}`;
  const queuePath = path.join(baseDir, `${QUEUE_FILENAME_PREFIX}${teamId}.json`);

  // Check for existing session
  const exists = await sessionExists(ctx, tmuxSession);
  if (exists.ok && exists.value) {
    return { ok: false, error: `tmux session '${tmuxSession}' already exists. Use /team-stop first.` };
  }

  // Initialize the queue file
  const queue = createQueue(teamId, goal);
  const writeResult = await writeQueue(queuePath, queue);
  if (!writeResult.ok) return writeResult;

  // Create tmux session with a live board viewer
  const sessionResult = await createSession(ctx, tmuxSession, {
    windowName: "board",
    cwd: workingDir,
  });
  if (!sessionResult.ok) return sessionResult;

  // Start a live view of the queue file in the board window
  await sendKeys(ctx, tmuxSession, "board", `watch -n 2 'cat ${queuePath} | python3 -m json.tool 2>/dev/null || echo "Waiting for queue..."'`);

  const agents: AgentInstance[] = [];

  // Launch permanent agents
  for (const agentDef of permanentAgents) {
    const agentConfig: AgentSideConfig = {
      teamId,
      goal,
      agentName: agentDef.name,
      role: agentDef.role,
      queuePath,
      canDispatch: agentDef.name === "orchestrator",
      canClose: agentDef.name === "evaluator",
      tmuxSession,
      workingDir,
      agentSideExtensionPath,
      agentsDirs,
    };

    const command = buildAgentCommand(agentDef, agentConfig, agentSideExtensionPath);

    const windowResult = await createWindow(ctx, tmuxSession, agentDef.name, {
      command,
      cwd: workingDir,
    });

    if (!windowResult.ok) {
      // Try to clean up on failure
      await killSession(ctx, tmuxSession);
      return windowResult;
    }

    agents.push({
      name: agentDef.name,
      role: agentDef.role,
      definitionName: agentDef.name,
      tmuxWindow: agentDef.name,
      status: "running",
    });
  }

  const team: TeamSession = {
    teamId,
    goal,
    tmuxSession,
    queuePath,
    repoRoot: ctx.cwd,
    workingDir,
    agents,
    createdAt: Date.now(),
  };

  // Give pi a few seconds to start, then inject initial prompts.
  // The orchestrator gets the goal; the evaluator is told to wait.
  setTimeout(async () => {
    const orchestratorPrompt = [
      `Your goal: ${goal}`,
      "",
      "Read the queue with read_queue, then plan the work by adding tasks.",
      "After adding tasks, dispatch them to workers and monitor for completion.",
    ].join("\n");

    const evaluatorPrompt = [
      "You are the evaluator for this team. Use wait_for_reviews to block",
      "until workers complete tasks and submit them for review.",
    ].join(" ");

    for (const agentDef of permanentAgents) {
      const prompt = agentDef.name === "orchestrator"
        ? orchestratorPrompt
        : evaluatorPrompt;
      await sendKeys(ctx, tmuxSession, agentDef.name, prompt);
    }
  }, INITIAL_PROMPT_DELAY_MS);

  return { ok: true, value: team };
}

/**
 * Spawn an ephemeral worker in a new tmux window for a specific task.
 *
 * @param ctx                    - Execution context.
 * @param team                   - Running team session.
 * @param workerDef              - Worker agent definition.
 * @param workerName             - Unique instance name (e.g., "worker-abc123").
 * @param taskPrompt             - Task description prompt for the worker.
 * @param agentSideExtensionPath - Absolute path to agent-side.ts.
 */
export async function spawnWorker(
  ctx: ExecContext,
  team: TeamSession,
  workerDef: AgentDefinition,
  workerName: string,
  taskPrompt: string,
  agentSideExtensionPath: string,
): Promise<Result<AgentInstance>> {
  const agentConfig: AgentSideConfig = {
    teamId: team.teamId,
    goal: team.goal,
    agentName: workerName,
    role: "worker",
    queuePath: team.queuePath,
    canDispatch: false,
    canClose: false,
    tmuxSession: team.tmuxSession,
    workingDir: team.workingDir,
    agentSideExtensionPath,
    agentsDirs: [],
  };

  const command = buildWorkerCommand(workerDef, agentConfig, agentSideExtensionPath, taskPrompt);

  const windowResult = await createWindow(ctx, team.tmuxSession, workerName, {
    command,
    cwd: team.workingDir,
  });

  if (!windowResult.ok) return windowResult;

  const instance: AgentInstance = {
    name: workerName,
    role: "worker",
    definitionName: workerDef.name,
    tmuxWindow: workerName,
    status: "running",
  };

  return { ok: true, value: instance };
}

/**
 * Stop a running team by killing its tmux session.
 *
 * @param ctx          - Execution context.
 * @param tmuxSession  - tmux session name to kill.
 */
export async function stopTeam(
  ctx: ExecContext,
  tmuxSession: string,
): Promise<Result<void>> {
  return killSession(ctx, tmuxSession);
}
