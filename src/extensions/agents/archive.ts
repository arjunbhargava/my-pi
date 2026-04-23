/**
 * Inventory of historical team agent work, assembled from the disk
 * layout written by {@link launchTeam} and {@link spawnAgentWindow}.
 *
 * This differs from {@link rediscoverTeams} in that it doesn't care
 * whether a team's tmux session is still alive — it walks the
 * worktrees baseDir for every `.team-<id>.json` queue file and every
 * `.team-configs/<teamId>-<agent>.json` config file, and pairs each
 * agent with its pi session archive under `~/.pi/agent/sessions/...`.
 *
 * Used by `/team-logs` so the user can inspect past sessions long
 * after the tmux windows are gone.
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import type { SessionFile } from "../../lib/session-archive.js";
import { listSessionFiles, sessionDirForCwd } from "../../lib/session-archive.js";
import { readQueue } from "../../lib/task-queue.js";
import type { TaskQueue } from "../../lib/types.js";
import { CONFIG_DIR_NAME } from "./launcher.js";
import { QUEUE_FILENAME_PREFIX } from "./types.js";
import type { AgentRole } from "./types.js";

export interface ArchivedAgent {
  agentName: string;
  role: AgentRole;
  workingDir: string;
  sessionDir: string;
  /** Newest session first. Empty if the agent never booted pi. */
  sessions: SessionFile[];
}

export interface ArchivedTeam {
  teamId: string;
  goal: string;
  queuePath: string;
  createdAt: number;
  updatedAt: number;
  agents: ArchivedAgent[];
}

/**
 * Enumerate every team visible under baseDir, live or not.
 * Teams without a corresponding queue file are not returned.
 */
export async function listTeamArchives(baseDir: string): Promise<ArchivedTeam[]> {
  const queueFiles = await listQueueFiles(baseDir);
  const configDir = path.join(baseDir, CONFIG_DIR_NAME);
  const configs = await listAgentConfigs(configDir);

  const teams: ArchivedTeam[] = [];
  for (const queuePath of queueFiles) {
    const queueResult = await readQueue(queuePath);
    if (!queueResult.ok) continue;
    const queue = queueResult.value;

    const agents = await resolveAgents(queue, configs.get(queue.teamId) ?? []);
    teams.push({
      teamId: queue.teamId,
      goal: queue.goal,
      queuePath,
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt,
      agents,
    });
  }

  teams.sort((a, b) => b.updatedAt - a.updatedAt);
  return teams;
}

/**
 * Look up one archived agent by exact name across all teams.
 * Returns the first match — agent names include the team-unique
 * `worker-<id>` suffix for workers and permanent role names (which
 * collide across teams, but the team id disambiguates upstream).
 * When `teamId` is set, restrict the search to that team.
 */
export async function findArchivedAgent(
  baseDir: string,
  agentName: string,
  teamId?: string,
): Promise<{ team: ArchivedTeam; agent: ArchivedAgent } | null> {
  const teams = await listTeamArchives(baseDir);
  for (const team of teams) {
    if (teamId && team.teamId !== teamId) continue;
    const agent = team.agents.find((a) => a.agentName === agentName);
    if (agent) return { team, agent };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Parsed shape of a per-agent config file. We only need a few fields. */
interface AgentConfigFile {
  teamId: string;
  agentName: string;
  role: AgentRole;
  workingDir: string;
}

/** Return absolute paths of every `.team-<id>.json` queue file in baseDir. */
async function listQueueFiles(baseDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(QUEUE_FILENAME_PREFIX) && name.endsWith(".json"))
    .map((name) => path.join(baseDir, name));
}

/**
 * Read every `<teamId>-<agent>.json` in the config dir. Returns a map
 * keyed by teamId so each team can look up its own agents in O(1).
 */
async function listAgentConfigs(configDir: string): Promise<Map<string, AgentConfigFile[]>> {
  const byTeam = new Map<string, AgentConfigFile[]>();
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    return byTeam;
  }

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let parsed: AgentConfigFile;
    try {
      const raw = await readFile(path.join(configDir, name), "utf-8");
      parsed = JSON.parse(raw) as AgentConfigFile;
    } catch {
      continue;
    }
    if (!parsed.teamId || !parsed.agentName || !parsed.workingDir) continue;

    const list = byTeam.get(parsed.teamId) ?? [];
    list.push(parsed);
    byTeam.set(parsed.teamId, list);
  }
  return byTeam;
}

/**
 * Combine the config-derived agent list (permanent agents + active
 * workers) with worker entries recovered from the queue's closed
 * list, so workers whose config was cleaned up still show in the
 * archive as long as a session directory remains.
 */
async function resolveAgents(
  queue: TaskQueue,
  configs: AgentConfigFile[],
): Promise<ArchivedAgent[]> {
  // Deduplicate by agentName — configs are authoritative for cwd,
  // but a worker might exist only in the queue's task/closed lists.
  const byName = new Map<string, { role: AgentRole; workingDir: string }>();

  for (const c of configs) {
    byName.set(c.agentName, { role: c.role, workingDir: c.workingDir });
  }

  // Fill in workers recorded by the queue whose config is gone.
  for (const task of queue.tasks) {
    if (task.assignedTo && task.worktreePath && !byName.has(task.assignedTo)) {
      byName.set(task.assignedTo, { role: "worker", workingDir: task.worktreePath });
    }
  }

  const agents: ArchivedAgent[] = [];
  for (const [agentName, info] of byName) {
    const sessionDir = sessionDirForCwd(info.workingDir);
    const allSessions = await listSessionFiles(sessionDir);
    // Permanent agents (orchestrator, evaluator, code-reviewer) all
    // run with cwd = repo root, so the session dir is shared with
    // every other pi invocation in that repo ever. Scope to sessions
    // that started on or after this team was created so unrelated
    // history doesn't show up in the listing. Workers have a
    // team-unique worktree cwd, so this filter is a no-op for them.
    const sessions = allSessions.filter((s) =>
      s.startMs === null ? true : s.startMs >= queue.createdAt,
    );
    agents.push({
      agentName,
      role: info.role,
      workingDir: info.workingDir,
      sessionDir,
      sessions,
    });
  }

  // Stable order: permanent first (alpha), then workers (alpha).
  agents.sort((a, b) => {
    if (a.role !== b.role) return a.role === "permanent" ? -1 : 1;
    return a.agentName.localeCompare(b.agentName);
  });
  return agents;
}
