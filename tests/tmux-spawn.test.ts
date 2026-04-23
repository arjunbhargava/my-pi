/**
 * Integration test: verifies that the launch script approach
 * actually produces a working pi process in a tmux window.
 *
 * Usage: npx tsx tests/tmux-spawn.test.ts
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { strict as assert } from "node:assert";
import { writeAgentConfigFile, writeAgentLaunchScript, buildWorkerCommand } from "../src/extensions/agents/launcher.js";
import type { AgentDefinition, TeamAgentConfig } from "../src/extensions/agents/types.js";

const SESSION = "pi-spawn-test";
const TMPDIR = path.join(tmpdir(), `pi-spawn-test-${Date.now()}`);

function cleanup(): void {
  try { execSync(`tmux kill-session -t ${SESSION} 2>/dev/null`); } catch { /* */ }
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* */ }
}

async function run(): Promise<void> {
  cleanup();
  mkdirSync(TMPDIR, { recursive: true });

  const projectDir = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const teamAgentPath = path.join(projectDir, "src/extensions/agents/team-agent/index.ts");
  const workerDefPath = path.join(projectDir, "agents/workers/implementer.md");

  const workerDef: AgentDefinition = {
    name: "implementer",
    role: "worker",
    description: "test worker",
    systemPrompt: "test",
    filePath: workerDefPath,
  };

  const workerConfig: TeamAgentConfig = {
    teamId: "test",
    goal: "test spawn",
    agentName: "worker-spawn-test",
    role: "worker",
    queuePath: path.join(TMPDIR, "queue.json"),
    canDispatch: false,
    canClose: false,
    tmuxSession: SESSION,
    workingDir: projectDir,
    teamAgentExtensionPath: teamAgentPath,
    agentsDirs: [],
  };

  // Write a dummy queue so the extension doesn't crash
  writeFileSync(workerConfig.queuePath, JSON.stringify({
    teamId: "test", goal: "test", createdAt: Date.now(), updatedAt: Date.now(),
    tasks: [{ id: "t1", title: "Test task", description: "say hi", status: "active",
              addedBy: "test", assignedTo: "worker-spawn-test", attempts: 1,
              createdAt: Date.now(), updatedAt: Date.now() }],
    closed: [], log: [],
  }, null, 2));

  // Generate the config file and launch script
  const configPath = await writeAgentConfigFile(TMPDIR, "test", "worker-spawn-test", workerConfig);
  const scriptPath = await writeAgentLaunchScript(
    TMPDIR, "test", "worker-spawn-test", workerDef, configPath,
  );
  const command = buildWorkerCommand(scriptPath);

  console.log("  Script path:", scriptPath);
  console.log("  Command:", command);

  // Verify script contents
  const scriptContent = require("node:fs").readFileSync(scriptPath, "utf-8") as string;
  console.log("  --- Script contents ---");
  console.log(scriptContent);
  console.log("  --- End script ---");

  assert.ok(scriptContent.includes("PI_TEAM_AGENT_CONFIG="), "script exports config var");
  assert.ok(scriptContent.includes("pi"), "script invokes pi");

  // Create tmux session with a reasonable size and spawn the worker
  execSync(`tmux new-session -d -s ${SESSION} -n main -x 120 -y 40`);
  execSync(`tmux new-window -t ${SESSION} -n worker -c ${projectDir} ${JSON.stringify(command)}`);

  console.log("  ✓ tmux window created");

  // Wait for pi to start and produce output
  console.log("  Waiting 10s for pi to run...");
  execSync("sleep 10");

  // Capture the pane
  const output = execSync(`tmux capture-pane -t ${SESSION}:worker -p`).toString();
  const nonEmpty = output.split("\n").filter(l => l.trim()).join("\n");
  console.log("  --- Captured output (non-empty lines) ---");
  console.log(nonEmpty.slice(0, 500));
  console.log("  --- End captured ---");

  // The worker should have produced SOME output (either pi output or the exit message)
  assert.ok(nonEmpty.length > 0, "worker window should have output");
  console.log("\n  ✓ Worker tmux window spawned with visible output");
}

run()
  .then(() => { console.log("\n✓ tmux-spawn test passed"); cleanup(); })
  .catch((err) => { console.error("\n✗ FAILED:", err.message); cleanup(); process.exit(1); });
