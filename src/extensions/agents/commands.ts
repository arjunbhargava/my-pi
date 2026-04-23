/**
 * Command registration for the multi-agent extension.
 *
 * Provides /team-start, /team-status, /team-stop, and /team-attach
 * commands for the user's control-plane pi instance.
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { getCurrentBranch } from "../../lib/git.js";
import { renderSessionToText } from "../../lib/session-archive.js";
import { discoverAgentsFromDirs } from "./agent-config.js";
import { findArchivedAgent, listTeamArchives } from "./archive.js";
import type { ArchivedTeam } from "./archive.js";
import { CONFIG_DIR_NAME, launchTeam, stopTeam } from "./launcher.js";
import { getQueueSummary, readQueue } from "../../lib/task-queue.js";
import { listWindows } from "../../lib/tmux.js";
import type { ExecContext } from "../../lib/types.js";
import type { TeamSession } from "./types.js";

// ---------------------------------------------------------------------------
// Types (mirrors pi's command shape without importing)
// ---------------------------------------------------------------------------

interface CommandUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
  input(prompt: string, defaultValue?: string): Promise<string | undefined>;
  select(title: string, choices: string[]): Promise<string | undefined>;
  setStatus(id: string, text: string): void;
}

type CommandHandler = (args: string | undefined, ctx: { ui: CommandUI }) => Promise<void>;
type CommandRegistrar = (name: string, opts: { description: string; handler: CommandHandler }) => void;

// ---------------------------------------------------------------------------
// State shared across commands
// ---------------------------------------------------------------------------

export interface AgentCommandState {
  /** Currently running team sessions. Keyed by teamId. */
  activeTeams: Map<string, TeamSession>;
  /** Build an ExecContext for a given cwd. */
  execCtx: (cwd: string) => ExecContext;
  /** Absolute path to the repo root, or null. */
  repoRoot: string | null;
  /** Absolute path to the agents directory within the my-pi package. */
  packageAgentsDir: string;
  /** Absolute path to the team-agent extension entry point. */
  teamAgentExtensionPath: string;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all multi-agent commands.
 *
 * @param state    - Shared command state.
 * @param register - The `pi.registerCommand` function.
 */
export function registerAgentCommands(
  state: AgentCommandState,
  register: CommandRegistrar,
): void {

  register("team-start", {
    description: "Launch a multi-agent team to work on a goal",
    handler: async (args, ctx) => {
      if (!state.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      // Get the goal
      let goal = args?.trim();
      if (!goal) {
        const input = await ctx.ui.input("Team goal:");
        if (!input) return;
        goal = input;
      }

      // Discover available agents
      const projectAgentsDir = path.join(state.repoRoot, ".pi", "agents");
      const { agents, errors } = await discoverAgentsFromDirs([
        state.packageAgentsDir,
        projectAgentsDir,
      ]);

      if (errors.length > 0) {
        ctx.ui.notify(`Agent parse warnings:\n${errors.join("\n")}`, "warning");
      }

      const permanentAgents = agents.filter((a) => a.role === "permanent");
      if (permanentAgents.length === 0) {
        ctx.ui.notify("No permanent agent definitions found (need orchestrator + evaluator).", "error");
        return;
      }

      // Detect the target branch (where completed work will merge)
      const branchResult = await getCurrentBranch(state.execCtx(state.repoRoot));
      if (!branchResult.ok) {
        ctx.ui.notify(`Could not detect current branch: ${branchResult.error}`, "error");
        return;
      }
      const targetBranch = branchResult.value;

      // Confirm launch
      const agentNames = permanentAgents.map((a) => a.name).join(", ");
      const workerNames = agents.filter((a) => a.role === "worker").map((a) => a.name).join(", ");
      const confirmed = await ctx.ui.confirm(
        "Launch team?",
        `Goal: ${goal}\nTarget branch: ${targetBranch}\nPermanent agents: ${agentNames}\nAvailable workers: ${workerNames || "none"}`,
      );
      if (!confirmed) return;

      // Determine working directory
      const workingDir = state.repoRoot;
      const baseDir = `${state.repoRoot}-worktrees`;

      const agentsDirs = [state.packageAgentsDir, projectAgentsDir];

      const result = await launchTeam(
        state.execCtx(state.repoRoot),
        goal,
        permanentAgents,
        state.teamAgentExtensionPath,
        baseDir,
        workingDir,
        agentsDirs,
        targetBranch,
      );

      if (!result.ok) {
        ctx.ui.notify(`Failed to launch team: ${result.error}`, "error");
        return;
      }

      const team = result.value;
      state.activeTeams.set(team.teamId, team);

      // Update control-plane footer
      const teamNames = Array.from(state.activeTeams.values()).map((t) => t.goal);
      ctx.ui.setStatus("team-ctrl", `[teams: ${teamNames.join(", ")}]`);

      ctx.ui.notify(
        [
          `━━━ Team Launched ━━━`,
          `Goal: ${team.goal}`,
          `Session: ${team.tmuxSession}`,
          `Queue: ${team.queuePath}`,
          `Agents: ${team.agents.map((a) => a.name).join(", ")}`,
          "",
          `The orchestrator will draft a plan and wait for your approval`,
          `before dispatching any workers. Attach to review it:`,
          `  tmux attach -t ${team.tmuxSession} \\; select-window -t orchestrator`,
          `Switch windows once attached: Ctrl+B then N/P`,
        ].join("\n"),
        "info",
      );
    },
  });

  register("team-status", {
    description: "Show status of running agent teams",
    handler: async (_args, ctx) => {
      if (state.activeTeams.size === 0) {
        ctx.ui.notify("No active teams. Use /team-start to launch one.", "info");
        return;
      }

      const lines: string[] = [];

      for (const team of state.activeTeams.values()) {
        lines.push(`Team: ${team.goal} (${team.teamId})`);
        lines.push(`  tmux: ${team.tmuxSession}`);

        // Read queue status
        const queueResult = await readQueue(team.queuePath);
        if (queueResult.ok) {
          const summary = getQueueSummary(queueResult.value);
          for (const line of summary.split("\n")) {
            lines.push(`  ${line}`);
          }
        } else {
          lines.push(`  Queue: ${queueResult.error}`);
        }

        // List tmux windows
        const windowsResult = await listWindows(state.execCtx(team.repoRoot), team.tmuxSession);
        if (windowsResult.ok) {
          lines.push(`  Windows: ${windowsResult.value.map((w) => w.name).join(", ")}`);
        }

        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  register("team-stop", {
    description: "Stop a running agent team and kill its tmux session",
    handler: async (_args, ctx) => {
      if (state.activeTeams.size === 0) {
        ctx.ui.notify("No active teams.", "info");
        return;
      }

      let team: TeamSession;

      if (state.activeTeams.size === 1) {
        team = state.activeTeams.values().next().value!;
      } else {
        const choices = Array.from(state.activeTeams.values()).map(
          (t) => `${t.goal} (${t.teamId})`,
        );
        const choice = await ctx.ui.select("Stop which team?", choices);
        if (!choice) return;
        const index = choices.indexOf(choice);
        team = Array.from(state.activeTeams.values())[index];
      }

      const confirmed = await ctx.ui.confirm(
        "Stop team?",
        `Kill tmux session '${team.tmuxSession}' and all agent processes?`,
      );
      if (!confirmed) return;

      const result = await stopTeam(state.execCtx(team.repoRoot), team.tmuxSession);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      state.activeTeams.delete(team.teamId);
      ctx.ui.notify(`Stopped team: ${team.goal}`, "info");
    },
  });

  register("team-logs", {
    description:
      "List past team agent sessions, or render one agent's newest session as a text transcript (search with rg).",
    handler: async (args, ctx) => {
      if (!state.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }
      const baseDir = `${state.repoRoot}-worktrees`;
      const agentName = args?.trim();

      if (!agentName) {
        const teams = await listTeamArchives(baseDir);
        ctx.ui.notify(formatArchiveListing(teams, baseDir), "info");
        return;
      }

      const match = await findArchivedAgent(baseDir, agentName);
      if (!match) {
        ctx.ui.notify(
          `No archived agent named '${agentName}'. Run /team-logs (no args) to see what's available.`,
          "error",
        );
        return;
      }
      const { team, agent } = match;
      if (agent.sessions.length === 0) {
        ctx.ui.notify(
          `Agent '${agentName}' (team ${team.teamId}) has no recorded sessions at ${agent.sessionDir}.`,
          "warning",
        );
        return;
      }

      const newest = agent.sessions[0];
      let transcript: string;
      try {
        transcript = await renderSessionToText(newest.path);
      } catch (err) {
        ctx.ui.notify(
          `Failed to render session: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      const outDir = path.join(baseDir, CONFIG_DIR_NAME);
      await mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, `${team.teamId}-${agent.agentName}.transcript.txt`);
      await writeFile(outPath, transcript, "utf-8");

      ctx.ui.notify(
        [
          `Rendered transcript for ${agent.agentName} (team ${team.teamId}):`,
          `  ${outPath}`,
          "",
          `Source: ${newest.path}`,
          agent.sessions.length > 1
            ? `(${agent.sessions.length - 1} older session(s) also in ${agent.sessionDir})`
            : "",
          "",
          `Search all transcripts: rg 'pattern' ${outDir}`,
        ].filter(Boolean).join("\n"),
        "info",
      );
    },
  });

  register("team-attach", {
    description: "Print the tmux attach command for a running team",
    handler: async (_args, ctx) => {
      if (state.activeTeams.size === 0) {
        ctx.ui.notify("No active teams.", "info");
        return;
      }

      let team: TeamSession;

      if (state.activeTeams.size === 1) {
        team = state.activeTeams.values().next().value!;
      } else {
        const choices = Array.from(state.activeTeams.values()).map(
          (t) => `${t.goal} (${t.teamId})`,
        );
        const choice = await ctx.ui.select("Attach to which team?", choices);
        if (!choice) return;
        const index = choices.indexOf(choice);
        team = Array.from(state.activeTeams.values())[index];
      }

      ctx.ui.notify(
        `Attach with:\n  tmux attach -t ${team.tmuxSession}\n\nSwitch windows: Ctrl+B then N/P`,
        "info",
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Human listing for `/team-logs` with no arguments. */
function formatArchiveListing(teams: ArchivedTeam[], baseDir: string): string {
  if (teams.length === 0) {
    return `No team archives under ${baseDir}. Launch one with /team-start.`;
  }

  const lines: string[] = [];
  for (const team of teams) {
    lines.push(`Team ${team.teamId}: ${team.goal}`);
    lines.push(`  queue: ${team.queuePath}`);
    lines.push(`  updated: ${new Date(team.updatedAt).toISOString()}`);

    if (team.agents.length === 0) {
      lines.push("  (no agent configs found)");
    } else {
      lines.push("  agents:");
      for (const agent of team.agents) {
        const sessionCount = agent.sessions.length;
        const newest = sessionCount > 0
          ? ` last ${new Date(agent.sessions[0].mtimeMs).toISOString()}`
          : " no sessions";
        lines.push(`    ${agent.agentName} [${agent.role}] — ${sessionCount} session(s)${newest}`);
      }
    }
    lines.push("");
  }

  lines.push(`Render a session: /team-logs <agent-name>`);
  return lines.join("\n");
}
