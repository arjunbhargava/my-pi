/**
 * Multi-agent coordination extension entry point.
 *
 * This is the control-plane extension loaded by the user's pi instance.
 * It registers commands for launching, monitoring, and stopping agent
 * teams. Worker spawning is handled directly by the orchestrator agent
 * via tmux — no polling or file-based dispatch needed here.
 *
 * This is the only file in the extension that imports from
 * `@mariozechner/pi-coding-agent`.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { getRepositoryRoot } from "../../lib/git.js";
import type { ExecContext } from "../../lib/types.js";
import { type AgentCommandState, registerAgentCommands } from "./commands.js";
import teamAgentExtension from "./team-agent/index.js";
import { AGENT_CONFIG_ENV_VAR } from "./types.js";
import type { TeamSession } from "./types.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentExtension(pi: ExtensionAPI): void {
  // When running as a spawned team agent, delegate to the team-agent
  // extension, which registers team tools instead of control-plane commands.
  if (process.env[AGENT_CONFIG_ENV_VAR]) {
    teamAgentExtension(pi);
    return;
  }

  // Resolve to the real filesystem path (not a worktree or symlink)
  // so that spawned agents reference stable paths that survive worktree cleanup.
  const rawExtensionDir = path.dirname(new URL(import.meta.url).pathname);
  let extensionDir: string;
  try {
    extensionDir = realpathSync(rawExtensionDir);
  } catch {
    extensionDir = rawExtensionDir;
  }
  const packageRoot = path.resolve(extensionDir, "..", "..", "..");
  const packageAgentsDir = path.join(packageRoot, "agents");
  const teamAgentExtensionPath = path.join(extensionDir, "team-agent", "index.ts");

  function execCtx(cwd: string): ExecContext {
    return { exec: (cmd, args, opts) => pi.exec(cmd, args, opts), cwd };
  }

  // Shared state for commands
  const commandState: AgentCommandState = {
    activeTeams: new Map<string, TeamSession>(),
    execCtx,
    repoRoot: null,
    packageAgentsDir,
    teamAgentExtensionPath,
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const rootResult = await getRepositoryRoot(execCtx(ctx.cwd));
    if (rootResult.ok) {
      commandState.repoRoot = rootResult.value;
    }

    // Show team status if any teams are tracked
    if (commandState.activeTeams.size > 0) {
      const names = Array.from(commandState.activeTeams.values()).map((t) => t.goal);
      ctx.ui.setStatus("team-ctrl", `[teams: ${names.join(", ")}]`);
    }
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  registerAgentCommands(commandState, pi.registerCommand.bind(pi));
}
