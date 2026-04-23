/**
 * Extension loaded inside each spawned team-agent pi process.
 *
 * A team agent (orchestrator, evaluator, or worker) runs its own pi
 * session in a tmux window. This entry point detects that the process
 * is a team agent by reading the config env var, builds a shared
 * runtime, and registers the tools appropriate to its capabilities.
 *
 * This is the only file in the team-agent context that imports from
 * `@mariozechner/pi-coding-agent`. Tool modules receive the runtime
 * and the bare `registerTool` surface they need.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { registerSessionHooks } from "./session.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import { registerQueueTools } from "./tools/queue.js";
import { registerReviewTools } from "./tools/review.js";

export default function teamAgentExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  if (!config) return;  // Not running as a team agent — silently skip.

  const runtime = createRuntime(pi, config);

  registerSessionHooks(pi, runtime);
  registerQueueTools(pi, runtime);
  if (config.capabilities.includes("dispatch")) registerDispatchTools(pi, runtime);
  if (config.capabilities.includes("close")) registerReviewTools(pi, runtime);
}
