/**
 * Debug script: generates a worker launch script, prints the tmux
 * command that would invoke it, and tries to run that command in a
 * throwaway tmux session.
 *
 * Usage: npx tsx tests/debug-command.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  buildAgentCommand,
  writeAgentConfigFile,
  writeAgentLaunchScript,
} from "../src/extensions/agents/launcher.js";
import type { AgentDefinition, TeamAgentConfig } from "../src/extensions/agents/types.js";

const fakeDef: AgentDefinition = {
  name: "implementer",
  role: "worker",
  description: "test",
  model: "claude-sonnet-4-5",
  tools: ["read", "bash", "edit", "write", "grep", "find"],
  capabilities: [],
  systemPrompt: "You are a worker.",
  filePath: `${process.cwd()}/agents/workers/implementer.md`,
};

const fakeConfig: TeamAgentConfig = {
  teamId: "test123",
  goal: "test goal",
  agentName: "worker-test",
  role: "worker",
  queuePath: "/tmp/fake-queue.json",
  capabilities: [],
  tmuxSession: "pi-test",
  workingDir: process.cwd(),
  teamAgentExtensionPath: `${process.cwd()}/src/extensions/agents/team-agent/index.ts`,
  agentsDirs: [],
};

async function main(): Promise<void> {
  const baseDir = "/tmp/debug-team";
  mkdirSync(baseDir, { recursive: true });

  const configPath = await writeAgentConfigFile(baseDir, fakeConfig.teamId, fakeConfig.agentName, fakeConfig);
  const scriptPath = await writeAgentLaunchScript(
    baseDir, fakeConfig.teamId, fakeConfig.agentName, fakeDef, configPath,
  );

  const cmd = buildAgentCommand(scriptPath);
  console.log("=== GENERATED COMMAND ===");
  console.log(cmd);
  console.log(`\n=== LENGTH: ${cmd.length} chars ===\n`);

  console.log("=== TESTING IN TMUX ===");
  try {
    execSync("tmux kill-session -t pi-debug-test 2>/dev/null", { stdio: "ignore" });
  } catch { /* ignore */ }

  try {
    execSync("tmux new-session -d -s pi-debug-test -n main");
    execSync(`tmux new-window -t pi-debug-test -n worker ${JSON.stringify(cmd)}`);
    console.log("  ✓ tmux new-window succeeded");

    execSync("sleep 2");
    const output = execSync("tmux capture-pane -t pi-debug-test:worker -p").toString();
    console.log("=== CAPTURED OUTPUT ===");
    console.log(output.slice(0, 500));
  } catch (err) {
    console.log(`  ✗ Error: ${err instanceof Error ? err.message : err}`);
  } finally {
    try { execSync("tmux kill-session -t pi-debug-test 2>/dev/null"); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
