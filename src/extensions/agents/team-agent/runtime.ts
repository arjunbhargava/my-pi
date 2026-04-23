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
import * as lockfile from "proper-lockfile";

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
  /**
   * Run a queue mutation under an advisory file lock: acquire the lock,
   * load a fresh copy of the queue, let the caller mutate it, save, and
   * release. Every load-mutate-save cycle must go through this to avoid
   * lost writes when multiple agents mutate concurrently. Long-running
   * side effects (git, tmux) should stay OUTSIDE the callback.
   */
  withQueueLock<T>(fn: (queue: TaskQueue) => Promise<T> | T): Promise<T>;

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

    async withQueueLock(fn) {
      // proper-lockfile creates a sibling `.lock` dir next to the queue
      // file and retries with backoff if another process holds it. The
      // `stale` window lets us reclaim a lock orphaned by a crashed
      // agent; the retry budget covers normal contention between
      // concurrent add_task / complete_task calls.
      const release = await lockfile.lock(config.queuePath, {
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
        stale: 10_000,
      });
      try {
        const readResult = await readQueue(config.queuePath);
        if (!readResult.ok) throw new Error(readResult.error);
        const queue = readResult.value;
        const result = await fn(queue);
        const writeResult = await writeQueue(config.queuePath, queue);
        if (!writeResult.ok) throw new Error(`Error writing queue: ${writeResult.error}`);
        return result;
      } finally {
        await release();
      }
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
