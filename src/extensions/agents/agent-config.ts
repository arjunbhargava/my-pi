/**
 * Agent definition discovery and parsing.
 *
 * Agent definitions are markdown files with YAML frontmatter:
 *
 * ```markdown
 * ---
 * name: scout
 * description: Fast codebase reconnaissance
 * model: claude-haiku-4-5
 * tools: read, grep, find, ls, bash
 * ---
 *
 * System prompt content here...
 * ```
 *
 * Roles live in `agents/roles/`, workers in `agents/workers/`.
 * Discovery checks both the my-pi package dir and project-local `.pi/agents/`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";

import type { Result } from "../../lib/types.js";
import {
  type AgentDefinition,
  type AgentRole,
  type Capability,
  CAPABILITIES,
  ROLES_DIR,
  WORKERS_DIR,
} from "./types.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing (minimal, no yaml dependency)
// ---------------------------------------------------------------------------

/** Regex to extract YAML frontmatter between --- delimiters. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a simple YAML frontmatter block into key-value pairs.
 * Handles only flat scalar and comma-separated list values.
 * This avoids pulling in a full YAML parser dependency.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Parse a single agent markdown file into an {@link AgentDefinition}.
 *
 * @param filePath - Absolute path to the .md file.
 * @param role     - Whether this agent is permanent or a worker.
 */
export async function parseAgentFile(
  filePath: string,
  role: AgentRole,
): Promise<Result<AgentDefinition>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cannot read agent file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { ok: false, error: `No YAML frontmatter found in '${filePath}'` };
  }

  const meta = parseFrontmatter(match[1]);
  const systemPrompt = match[2].trim();

  const name = meta.name;
  if (!name) {
    return { ok: false, error: `Missing 'name' in frontmatter of '${filePath}'` };
  }

  const tools = meta.tools
    ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  const capabilitiesResult = parseCapabilities(meta.capabilities, filePath);
  if (!capabilitiesResult.ok) return capabilitiesResult;

  return {
    ok: true,
    value: {
      name,
      role,
      description: meta.description ?? "",
      model: meta.model || undefined,
      tools,
      capabilities: capabilitiesResult.value,
      systemPrompt,
      filePath,
    },
  };
}

/**
 * Parse the `capabilities` frontmatter value into a validated list.
 * An empty or missing value yields an empty array. Unknown values are
 * an error — typos should surface loudly rather than being silently ignored.
 */
function parseCapabilities(raw: string | undefined, filePath: string): Result<Capability[]> {
  if (!raw) return { ok: true, value: [] };

  const items = raw.split(",").map((c) => c.trim()).filter(Boolean);
  const valid: Capability[] = [];
  for (const item of items) {
    if (!CAPABILITIES.includes(item as Capability)) {
      return {
        ok: false,
        error: `Unknown capability '${item}' in '${filePath}'. Valid: ${CAPABILITIES.join(", ")}`,
      };
    }
    valid.push(item as Capability);
  }
  return { ok: true, value: valid };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * List all .md files in a directory, non-recursively.
 * Returns empty array if the directory doesn't exist.
 */
async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  try {
    const dirStat = await stat(dirPath);
    if (!dirStat.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = await readdir(dirPath);
  return entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dirPath, f));
}

/**
 * Discover all agent definitions from a base agents directory.
 *
 * Looks for:
 *   - `<baseDir>/roles/*.md` → permanent agents
 *   - `<baseDir>/workers/*.md` → ephemeral workers
 *
 * @param baseDir - Absolute path to the agents directory.
 * @returns Parsed definitions and any parse errors encountered.
 */
export async function discoverAgents(
  baseDir: string,
): Promise<{ agents: AgentDefinition[]; errors: string[] }> {
  const agents: AgentDefinition[] = [];
  const errors: string[] = [];

  const roleFiles = await listMarkdownFiles(path.join(baseDir, ROLES_DIR));
  const workerFiles = await listMarkdownFiles(path.join(baseDir, WORKERS_DIR));

  for (const file of roleFiles) {
    const result = await parseAgentFile(file, "permanent");
    if (result.ok) {
      agents.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  for (const file of workerFiles) {
    const result = await parseAgentFile(file, "worker");
    if (result.ok) {
      agents.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  return { agents, errors };
}

/**
 * Discover agents from multiple directories, with later sources
 * overriding earlier ones (by name). Allows project-local agents
 * to override package defaults.
 *
 * @param dirs - Directories to scan, in priority order (lowest first).
 */
export async function discoverAgentsFromDirs(
  dirs: string[],
): Promise<{ agents: AgentDefinition[]; errors: string[] }> {
  const byName = new Map<string, AgentDefinition>();
  const allErrors: string[] = [];

  for (const dir of dirs) {
    const { agents, errors } = await discoverAgents(dir);
    for (const agent of agents) {
      byName.set(agent.name, agent);
    }
    allErrors.push(...errors);
  }

  return { agents: Array.from(byName.values()), errors: allErrors };
}
