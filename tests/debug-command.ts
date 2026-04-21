/**
 * Debug script: prints the exact command string that would be
 * passed to tmux new-window for a worker, then tries to run it.
 *
 * Usage: npx tsx tests/debug-command.ts
 */

import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { buildWorkerCommand } from "../src/extensions/agents/launcher.js";
import type { AgentDefinition } from "../src/extensions/agents/types.js";

const fakeDef: AgentDefinition = {
  name: "implementer",
  role: "worker",
  description: "test",
  model: "claude-sonnet-4-5",
  tools: ["read", "bash", "edit", "write", "grep", "find"],
  systemPrompt: "You are a worker.",
  filePath: `${process.cwd()}/agents/workers/implementer.md`,
};

// Write a fake config file
const fakeConfig = {
  teamId: "test123",
  goal: "test goal",
  agentName: "worker-test",
  role: "worker",
  queuePath: "/tmp/fake-queue.json",
  canDispatch: false,
  canClose: false,
  tmuxSession: "pi-test",
  workingDir: process.cwd(),
  agentSideExtensionPath: `${process.cwd()}/src/extensions/agents/agent-side.ts`,
  agentsDirs: [],
};
const configPath = "/tmp/debug-agent-config.json";
writeFileSync(configPath, JSON.stringify(fakeConfig, null, 2));

const prompt = "You are worker-test. Your assigned task ID is: deadbeef. Use read_queue to get your task details, then do the work, then use complete_task when done.";

const cmd = buildWorkerCommand(fakeDef, configPath, fakeConfig.agentSideExtensionPath, prompt);

console.log("=== GENERATED COMMAND ===");
console.log(cmd);
console.log("");
console.log(`=== LENGTH: ${cmd.length} chars ===`);
console.log("");

// Try to run it in a tmux session to see what happens
console.log("=== TESTING IN TMUX ===");
try {
  execSync("tmux kill-session -t pi-debug-test 2>/dev/null", { stdio: "ignore" });
} catch { /* ignore */ }

try {
  execSync("tmux new-session -d -s pi-debug-test -n main");
  // Pass the command exactly as pi.exec would — as a single argument
  execSync(`tmux new-window -t pi-debug-test -n worker ${JSON.stringify(cmd)}`);
  console.log("  ✓ tmux new-window succeeded");

  // Wait and capture
  execSync("sleep 2");
  const output = execSync("tmux capture-pane -t pi-debug-test:worker -p").toString();
  console.log("=== CAPTURED OUTPUT ===");
  console.log(output.slice(0, 500));
} catch (err) {
  console.log(`  ✗ Error: ${err instanceof Error ? err.message : err}`);
} finally {
  try { execSync("tmux kill-session -t pi-debug-test 2>/dev/null"); } catch { /* ignore */ }
}
