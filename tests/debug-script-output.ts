import { writeAgentConfigFile, writeAgentLaunchScript } from "../src/extensions/agents/launcher.js";
import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const base = "/tmp/script-test";
  const config = await writeAgentConfigFile(base, "test", "worker-1", {
    teamId: "test", goal: "test", agentName: "worker-1", role: "worker",
    queuePath: "/tmp/q.json", canDispatch: false, canClose: false,
    tmuxSession: "pi-team-test", workingDir: "/tmp",
    agentSideExtensionPath: `${cwd}/src/extensions/agents/agent-side.ts`,
    agentsDirs: [],
  });
  const script = await writeAgentLaunchScript(base, "test", "worker-1", {
    name: "implementer", role: "worker", description: "test",
    systemPrompt: "test", filePath: `${cwd}/agents/workers/implementer.md`,
  }, config, `${cwd}/src/extensions/agents/agent-side.ts`, "Say hello, this is a test");

  console.log("=== Generated script ===");
  console.log(readFileSync(script, "utf-8"));
}
main();
