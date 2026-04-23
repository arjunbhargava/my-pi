/**
 * Load the team-agent config from the process environment.
 *
 * The launcher writes the config to a JSON file and sets the env var
 * to that file path. Legacy tests may still set the env var to an
 * inline JSON string — both forms are accepted here. If the env var
 * is unset or malformed, the caller should treat the current process
 * as a regular (non-team) pi session.
 */

import { readFileSync } from "node:fs";

import { AGENT_CONFIG_ENV_VAR, type TeamAgentConfig } from "../types.js";

/** Return the parsed config, or null if the process isn't a team agent. */
export function loadConfig(): TeamAgentConfig | null {
  const ref = process.env[AGENT_CONFIG_ENV_VAR];
  if (!ref) return null;

  try {
    const raw = ref.endsWith(".json") ? readFileSync(ref, "utf-8") : ref;
    return JSON.parse(raw) as TeamAgentConfig;
  } catch {
    return null;
  }
}
