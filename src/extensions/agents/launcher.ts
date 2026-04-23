/**
 * Team launcher: creates tmux sessions and spawns agent processes.
 *
 * Builds the pi command line for each agent, creates the tmux session
 * and windows, and initializes the task queue. This module does not
 * import from `@mariozechner/pi-coding-agent`.
 *
 * Agent configuration is passed via a JSON file (not an env var)
 * to avoid shell escaping issues with nested JSON in command strings.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
import type { AgentDefinition, AgentInstance, TeamAgentConfig, TeamSession } from "./types.js";
import {
  AGENT_CONFIG_ENV_VAR,
  QUEUE_FILENAME_PREFIX,
  TEAM_TMUX_PREFIX,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay (ms) before injecting initial prompts into permanent agent windows. */
const INITIAL_PROMPT_DELAY_MS = 6000;

/** Directory name for agent config files within the team base dir. */
const CONFIG_DIR_NAME = ".team-configs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Shell-safe single-quoted string. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Write the agent config to a JSON file and return its absolute path.
 * This avoids embedding large JSON blobs in shell command strings.
 */
export async function writeAgentConfigFile(
  baseDir: string,
  teamId: string,
  agentName: string,
  config: TeamAgentConfig,
): Promise<string> {
  const configDir = path.join(baseDir, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, `${teamId}-${agentName}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

// ---------------------------------------------------------------------------
// Command building
// ---------------------------------------------------------------------------

/**
 * Write a launcher shell script for an agent and return its path.
 *
 * We use a script file instead of inline `bash -c` to avoid shell
 * escaping hell with nested quotes in tmux commands. The script:
 *   1. Exports the config env var
 *   2. Runs pi with the right flags
 *   3. For workers: keeps the window open on exit for debugging
 */
export async function writeAgentLaunchScript(
  baseDir: string,
  teamId: string,
  agentName: string,
  agentDef: AgentDefinition,
  configPath: string,
): Promise<string> {
  const configDir = path.join(baseDir, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const scriptPath = path.join(configDir, `${teamId}-${agentName}.sh`);

  // Log file for diagnostics — lives next to the script
  const logPath = scriptPath.replace(/\.sh$/, ".log");

  const lines: string[] = [
    "#!/usr/bin/env bash",
    `LOGFILE=${sq(logPath)}`,
    `echo "[$(date)] Agent ${agentName} starting" >> "$LOGFILE"`,
    `export ${AGENT_CONFIG_ENV_VAR}=${sq(configPath)}`,
    `echo "[$(date)] Config: $${AGENT_CONFIG_ENV_VAR}" >> "$LOGFILE"`,
    "",
  ];

  // System prompt is injected via the extension's before_agent_start hook
  // (not --append-system-prompt, which causes hangs in -p mode with extensions).
  const piArgs: string[] = [
    "pi",
  ];

  if (agentDef.model) {
    piArgs.push("--model", agentDef.model);
  }
  // Note: agentDef.tools is intentionally NOT passed as --tools.
  // The --tools flag acts as a whitelist that would filter out
  // custom tools registered by the team-agent extension.
  // Tool guidance comes from the agent's system prompt instead.
  // All agents run in interactive mode — no -p flag.
  // Task prompts are injected via tmux send-keys after pi starts.
  const piCommand = piArgs.join(" ");
  lines.push(`echo "[$(date)] Running: ${piCommand.replace(/'/g, "")}" >> "$LOGFILE"`);
  lines.push(piCommand);
  lines.push(`echo "[$(date)] pi exited with code $?" >> "$LOGFILE"`);

  await writeFile(scriptPath, lines.join("\n") + "\n", { mode: 0o755 });
  return scriptPath;
}

/**
 * Build the tmux command string for an agent.
 * Returns a simple `bash /path/to/script.sh` invocation.
 */
export function buildAgentCommand(scriptPath: string): string {
  return `bash ${sq(scriptPath)}`;
}

/**
 * Build a command to launch a worker for a specific task.
 */
export function buildWorkerCommand(
  scriptPath: string,
): string {
  return buildAgentCommand(scriptPath);
}

// ---------------------------------------------------------------------------
// Team lifecycle
// ---------------------------------------------------------------------------

/**
 * Launch a new team session.
 *
 * Creates:
 *   1. A task queue file initialized with the goal
 *   2. Agent config files (one per permanent agent)
 *   3. A tmux session with a board window + one window per permanent agent
 *   4. Injects initial prompts after a delay
 */
export async function launchTeam(
  ctx: ExecContext,
  goal: string,
  permanentAgents: AgentDefinition[],
  teamAgentExtensionPath: string,
  baseDir: string,
  workingDir: string,
  agentsDirs: string[],
  targetBranch: string,
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
  const queue = createQueue(teamId, goal, targetBranch);
  const writeResult = await writeQueue(queuePath, queue);
  if (!writeResult.ok) return writeResult;

  // Create tmux session with a live board viewer
  const sessionResult = await createSession(ctx, tmuxSession, {
    windowName: "board",
    cwd: workingDir,
  });
  if (!sessionResult.ok) return sessionResult;

  await sendKeys(
    ctx, tmuxSession, "board",
    `watch -n 2 'cat ${sq(queuePath)} | python3 -m json.tool 2>/dev/null || echo "Waiting for queue..."'`,
  );

  const agents: AgentInstance[] = [];

  // Launch permanent agents
  for (const agentDef of permanentAgents) {
    const agentConfig: TeamAgentConfig = {
      teamId,
      goal,
      agentName: agentDef.name,
      role: agentDef.role,
      queuePath,
      capabilities: agentDef.capabilities,
      tmuxSession,
      workingDir,
      teamAgentExtensionPath,
      agentsDirs,
      agentSystemPrompt: agentDef.systemPrompt,
    };

    const configPath = await writeAgentConfigFile(baseDir, teamId, agentDef.name, agentConfig);
    const scriptPath = await writeAgentLaunchScript(
      baseDir, teamId, agentDef.name, agentDef, configPath,
    );
    const command = buildAgentCommand(scriptPath);

    const windowResult = await createWindow(ctx, tmuxSession, agentDef.name, {
      command,
      cwd: workingDir,
    });

    if (!windowResult.ok) {
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
    targetBranch,
    agents,
    createdAt: Date.now(),
  };

  // Give pi time to start, then inject initial prompts via send-keys.
  // Single-line prompts to avoid editor issues.
  setTimeout(async () => {
    for (const agentDef of permanentAgents) {
      const prompt = agentDef.name === "orchestrator"
        ? `Your goal: ${goal}. Read the queue, plan tasks, dispatch workers, and monitor for completion.`
        : "Use wait_for_reviews to wait for completed tasks, then review and close or reject them.";
      await sendKeys(ctx, tmuxSession, agentDef.name, prompt);
    }
  }, INITIAL_PROMPT_DELAY_MS);

  return { ok: true, value: team };
}

/** Delay (ms) before injecting a task prompt into a newly spawned worker. */
const WORKER_PROMPT_DELAY_MS = 5000;

/**
 * Spawn a worker as a full interactive pi session in a new tmux window.
 * The task prompt is injected via sendKeys after pi starts.
 */
export async function spawnWorker(
  ctx: ExecContext,
  team: TeamSession,
  workerDef: AgentDefinition,
  workerName: string,
  taskPrompt: string,
  teamAgentExtensionPath: string,
): Promise<Result<AgentInstance>> {
  const agentConfig: TeamAgentConfig = {
    teamId: team.teamId,
    goal: team.goal,
    agentName: workerName,
    role: "worker",
    queuePath: team.queuePath,
    capabilities: [],
    tmuxSession: team.tmuxSession,
    workingDir: team.workingDir,
    teamAgentExtensionPath,
    agentsDirs: [],
    agentSystemPrompt: workerDef.systemPrompt,
  };

  const baseDir = path.dirname(team.queuePath);
  const configPath = await writeAgentConfigFile(baseDir, team.teamId, workerName, agentConfig);
  const scriptPath = await writeAgentLaunchScript(
    baseDir, team.teamId, workerName, workerDef, configPath,
  );
  const command = buildWorkerCommand(scriptPath);

  const windowResult = await createWindow(ctx, team.tmuxSession, workerName, {
    command,
    cwd: team.workingDir,
  });

  if (!windowResult.ok) return windowResult;

  // Inject the task prompt after pi has time to start
  setTimeout(async () => {
    await sendKeys(ctx, team.tmuxSession, workerName, taskPrompt);
  }, WORKER_PROMPT_DELAY_MS);

  return {
    ok: true,
    value: {
      name: workerName,
      role: "worker",
      definitionName: workerDef.name,
      tmuxWindow: workerName,
      status: "running",
    },
  };
}

/**
 * Stop a running team by killing its tmux session.
 */
export async function stopTeam(
  ctx: ExecContext,
  tmuxSession: string,
): Promise<Result<void>> {
  return killSession(ctx, tmuxSession);
}
