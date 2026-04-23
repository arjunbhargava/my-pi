/**
 * Shared runtime helpers for a team agent.
 *
 * The runtime bundles together everything the tool modules need from
 * pi: git/tmux execution contexts, queue I/O that throws on failure,
 * and small shortcuts for worker lifecycle operations. Building it
 * once in the extension entry point keeps each tool module free of
 * repeated boilerplate.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  readQueue,
  writeQueue,
} from "../../../lib/task-queue.js";
import { killWindow, listWindows } from "../../../lib/tmux.js";
import type {
  ExecContext,
  GitContext,
  TaskQueue,
} from "../../../lib/types.js";
import { destroyWorkspace } from "../../../lib/workspace.js";
import type { TeamAgentConfig } from "../types.js";

/**
 * Everything tool modules need from the surrounding pi session + team
 * config. Methods throw on failure so call sites can be linear.
 */
export interface TeamAgentRuntime {
  readonly pi: ExtensionAPI;
  readonly config: TeamAgentConfig;
  readonly agentName: string;
  readonly queuePath: string;

  /** Read the queue file. Throws if it's missing or malformed. */
  loadQueue(): Promise<TaskQueue>;
  /** Write the queue file atomically. Throws on I/O failure. */
  saveQueue(queue: TaskQueue): Promise<void>;

  /** Git context rooted at the main repository. */
  repoGit(): GitContext;
  /** Git context rooted at a specific worktree. */
  worktreeGit(worktreePath: string): GitContext;
  /** Exec context for tmux commands, rooted at this agent's working dir. */
  tmuxExec(): ExecContext;

  /** True if the named worker's tmux window is still alive. */
  isWorkerAlive(workerName: string): Promise<boolean>;
  /** Best-effort kill of a worker's tmux window. */
  killWorkerWindow(workerName: string): Promise<void>;
  /** Best-effort teardown of a worker's worktree + branch. */
  cleanupWorkerGit(worktreePath: string, branchName: string): Promise<void>;
}

/** Build a runtime from the pi extension API and the team-agent config. */
export function createRuntime(pi: ExtensionAPI, config: TeamAgentConfig): TeamAgentRuntime {
  const exec = (cmd: string, args: string[], opts?: { timeout?: number }) =>
    pi.exec(cmd, args, opts);

  const repoGit = (): GitContext => ({ exec, cwd: config.workingDir });
  const worktreeGit = (worktreePath: string): GitContext => ({ exec, cwd: worktreePath });
  const tmuxExec = (): ExecContext => ({ exec, cwd: config.workingDir });

  return {
    pi,
    config,
    agentName: config.agentName,
    queuePath: config.queuePath,

    async loadQueue() {
      const result = await readQueue(config.queuePath);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },

    async saveQueue(queue) {
      const result = await writeQueue(config.queuePath, queue);
      if (!result.ok) throw new Error(`Error writing queue: ${result.error}`);
    },

    repoGit,
    worktreeGit,
    tmuxExec,

    async isWorkerAlive(workerName) {
      const windows = await listWindows(tmuxExec(), config.tmuxSession);
      return windows.ok && windows.value.some((w) => w.name === workerName);
    },

    async killWorkerWindow(workerName) {
      await killWindow(tmuxExec(), config.tmuxSession, workerName);
    },

    async cleanupWorkerGit(worktreePath, branchName) {
      await destroyWorkspace(repoGit(), { worktreePath, branchName });
    },
  };
}
