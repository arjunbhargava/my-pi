/**
 * Extension loaded inside each spawned team-agent pi process.
 *
 * A team agent (orchestrator, evaluator, or worker) runs its own pi
 * session in a tmux window. This entry point detects that the process
 * is a team agent by reading the config env var, builds a shared
 * runtime, and registers exactly the tools appropriate to its role.
 *
 * Tool registration is driven by {@link getToolManifest}, which maps
 * role + capabilities to a precise tool set. No role gets tools it
 * shouldn't have — this prevents behavioral confusion where the model
 * picks the wrong blocking tool.
 *
 * This is the only file in the team-agent context that imports from
 * `@mariozechner/pi-coding-agent`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { getToolManifest } from "./manifest.js";
import { createRuntime } from "./runtime.js";
import { registerSessionHooks } from "./session.js";
import { registerDispatchTools } from "./tools/dispatch.js";
import {
  registerAddTask,
  registerCompleteTask,
  registerReadQueue,
  registerWaitForVerdict,
} from "./tools/queue.js";
import { registerReviewTools } from "./tools/review.js";

export default function teamAgentExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  if (!config) return;  // Not running as a team agent — silently skip.

  const runtime = createRuntime(pi, config);
  const manifest = getToolManifest(config);

  registerSessionHooks(pi, runtime);

  // Register tools based on the role manifest — each role gets exactly
  // the tools it needs, no more.
  if (manifest.readQueue) registerReadQueue(pi, runtime);
  if (manifest.addTask) registerAddTask(pi, runtime);
  if (manifest.completeTask) registerCompleteTask(pi, runtime);
  if (manifest.waitForVerdict) registerWaitForVerdict(pi, runtime);
  if (manifest.dispatch) registerDispatchTools(pi, runtime);
  if (manifest.review) registerReviewTools(pi, runtime);
}
