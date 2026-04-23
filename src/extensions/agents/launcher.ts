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
 *   2. Runs pi with the agent's model and an optional initial prompt
 *      (passed as a positional argument — pi processes it as the
 *      first user message, so no send-keys timing race is needed)
 *
 * System prompts are *not* passed via --append-system-prompt, which
 * hangs in -p mode when an extension is loaded. The team-agent
 * extension appends them via before_agent_start instead.
 *
 * Tools are *not* passed via --tools, which acts as a whitelist and
 * would filter out the team-agent extension's custom tools. Tool
 * guidance comes from the agent's system prompt instead.
 */
export async function writeAgentLaunchScript(
  baseDir: string,
  teamId: string,
  agentName: string,
  agentDef: AgentDefinition,
  configPath: string,
  initialPrompt?: string,
): Promise<string> {
  const configDir = path.join(baseDir, CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const scriptPath = path.join(configDir, `${teamId}-${agentName}.sh`);

  // Log file for diagnostics — lives next to the script.
  const logPath = scriptPath.replace(/\.sh$/, ".log");

  const piInvocation = ["pi"];
  if (agentDef.model) piInvocation.push("--model", sq(agentDef.model));
  if (initialPrompt) piInvocation.push(sq(initialPrompt));

  const lines: string[] = [
    "#!/usr/bin/env bash",
    `LOGFILE=${sq(logPath)}`,
    `echo "[$(date)] Agent ${agentName} starting" >> "$LOGFILE"`,
    `export ${AGENT_CONFIG_ENV_VAR}=${sq(configPath)}`,
    "",
    piInvocation.join(" "),
    `echo "[$(date)] pi exited with code $?" >> "$LOGFILE"`,
  ];

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

// ---------------------------------------------------------------------------
// Agent spawning
// ---------------------------------------------------------------------------

export interface SpawnAgentRequest {
  /** Parsed agent role/worker definition from a .md file. */
  agentDef: AgentDefinition;
  /** The TeamAgentConfig the spawned process will read on startup. */
  config: TeamAgentConfig;
  /** First user message sent to pi on startup. */
  initialPrompt?: string;
  /** Directory holding per-team artifacts (configs, scripts, logs). */
  baseDir: string;
}

/**
 * Spawn one team agent in a new tmux window.
 *
 * Writes the config JSON and launch script to {@link SpawnAgentRequest.baseDir},
 * then asks tmux to open a window in {@link TeamAgentConfig.workingDir}
 * that executes the script. Returns the window-creation result — the
 * caller is responsible for rollback on failure (the helper has no
 * notion of the surrounding team session or git state).
 */
export async function spawnAgentWindow(
  ctx: ExecContext,
  req: SpawnAgentRequest,
): Promise<Result<void>> {
  const { agentDef, config, initialPrompt, baseDir } = req;
  const configPath = await writeAgentConfigFile(baseDir, config.teamId, config.agentName, config);
  const scriptPath = await writeAgentLaunchScript(
    baseDir, config.teamId, config.agentName, agentDef, configPath, initialPrompt,
  );
  const command = buildAgentCommand(scriptPath);
  return createWindow(ctx, config.tmuxSession, config.agentName, {
    command,
    cwd: config.workingDir,
  });
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
 *
 * Each agent receives its initial prompt as a positional arg to pi,
 * so the first user turn starts as soon as pi's UI is ready — no
 * send-keys race, no sleep timers.
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

  const exists = await sessionExists(ctx, tmuxSession);
  if (exists.ok && exists.value) {
    return { ok: false, error: `tmux session '${tmuxSession}' already exists. Use /team-stop first.` };
  }

  // Initialize the queue file.
  const queue = createQueue(teamId, goal, targetBranch);
  const writeResult = await writeQueue(queuePath, queue);
  if (!writeResult.ok) return writeResult;

  // Create the tmux session with a live board viewer as the first window.
  const sessionResult = await createSession(ctx, tmuxSession, {
    windowName: "board",
    cwd: workingDir,
  });
  if (!sessionResult.ok) return sessionResult;

  await sendKeys(
    ctx, tmuxSession, "board",
    `watch -n 2 'cat ${sq(queuePath)} | python3 -m json.tool 2>/dev/null || echo "Waiting for queue..."'`,
  );

  const initialPrompt = buildPermanentAgentPrompt(goal);
  const agents: AgentInstance[] = [];

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

    const spawnResult = await spawnAgentWindow(ctx, {
      agentDef,
      config: agentConfig,
      initialPrompt,
      baseDir,
    });
    if (!spawnResult.ok) {
      await killSession(ctx, tmuxSession);
      return spawnResult;
    }

    agents.push({
      name: agentDef.name,
      role: agentDef.role,
      definitionName: agentDef.name,
      tmuxWindow: agentDef.name,
      status: "running",
    });
  }

  return {
    ok: true,
    value: {
      teamId,
      goal,
      tmuxSession,
      queuePath,
      repoRoot: ctx.cwd,
      workingDir,
      targetBranch,
      agents,
      createdAt: Date.now(),
    },
  };
}

/**
 * The initial message sent to every permanent agent on startup.
 * Agents know their role-specific workflow from their system prompt,
 * so the initial prompt is deliberately uniform — just the goal.
 */
function buildPermanentAgentPrompt(goal: string): string {
  return `Team goal: ${goal}. Begin per your role's workflow.`;
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
