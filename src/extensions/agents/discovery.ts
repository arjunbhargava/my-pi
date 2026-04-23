/**
 * Rediscover running teams when the control-plane pi starts up.
 *
 * The control-plane's `activeTeams` map is in-memory only, so quitting
 * pi loses track of any team whose tmux session is still alive. This
 * module pairs on-disk queue files with live tmux sessions and
 * rebuilds the {@link TeamSession} entries the commands depend on.
 *
 * Strategy:
 *   1. List `.team-*.json` files under the teams base dir.
 *   2. For each file, read the queue. The queue records its tmux
 *      session name (added in {@link createQueue}) so no slug
 *      re-derivation is needed.
 *   3. If tmux reports that session is alive, enumerate its windows
 *      and register the team. Otherwise, skip it silently — the
 *      queue belongs to a team that crashed or was killed, and the
 *      user may still want to inspect the file.
 *
 * Rediscovered teams get a best-effort agent list derived from tmux
 * window names: windows starting with `worker-` are tagged as workers,
 * the `board` window is excluded, and everything else is treated as a
 * permanent agent.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { readQueue } from "../../lib/task-queue.js";
import { listWindows, sessionExists } from "../../lib/tmux.js";
import type { ExecContext } from "../../lib/types.js";
import type { AgentInstance, AgentRole, TeamSession } from "./types.js";
import { QUEUE_FILENAME_PREFIX } from "./types.js";

/** tmux window name that hosts the live board viewer (not an agent). */
const BOARD_WINDOW_NAME = "board";

/** Prefix tmux windows use for ephemeral workers. */
const WORKER_WINDOW_PREFIX = "worker-";

export interface RediscoverResult {
  /** Teams whose tmux session is still alive. */
  live: TeamSession[];
  /** Queue files whose tmux session is gone (paths, for diagnostics). */
  stale: string[];
}

/**
 * Walk `baseDir` and return live/stale team partitions.
 *
 * @param ctx        - Exec context used to query tmux.
 * @param baseDir    - Directory containing `.team-<id>.json` queue files.
 * @param repoRoot   - Current pi session's repo root (used for rebuilt TeamSession).
 * @param workingDir - Working directory agents were launched in (typically repoRoot).
 */
export async function rediscoverTeams(
  ctx: ExecContext,
  baseDir: string,
  repoRoot: string,
  workingDir: string,
): Promise<RediscoverResult> {
  const queueFiles = await listQueueFiles(baseDir);
  const live: TeamSession[] = [];
  const stale: string[] = [];

  for (const queuePath of queueFiles) {
    const queueResult = await readQueue(queuePath);
    if (!queueResult.ok) {
      // Unreadable file — not a running team, but also not something
      // we want to blow up the entire rediscovery for.
      stale.push(queuePath);
      continue;
    }
    const queue = queueResult.value;

    const alive = await sessionExists(ctx, queue.tmuxSession);
    if (!alive.ok || !alive.value) {
      stale.push(queuePath);
      continue;
    }

    const windowsResult = await listWindows(ctx, queue.tmuxSession);
    const agents = windowsResult.ok ? agentsFromWindows(windowsResult.value) : [];

    live.push({
      teamId: queue.teamId,
      goal: queue.goal,
      tmuxSession: queue.tmuxSession,
      queuePath,
      repoRoot,
      workingDir,
      targetBranch: queue.targetBranch,
      agents,
      createdAt: queue.createdAt,
    });
  }

  return { live, stale };
}

/** Return absolute paths of every `.team-<id>.json` file in baseDir. */
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

/** Tag tmux windows with the role they most likely carry. */
function agentsFromWindows(windows: { name: string }[]): AgentInstance[] {
  const agents: AgentInstance[] = [];
  for (const w of windows) {
    if (w.name === BOARD_WINDOW_NAME) continue;
    const role: AgentRole = w.name.startsWith(WORKER_WINDOW_PREFIX) ? "worker" : "permanent";
    agents.push({
      name: w.name,
      role,
      definitionName: w.name,
      tmuxWindow: w.name,
      status: "running",
    });
  }
  return agents;
}
