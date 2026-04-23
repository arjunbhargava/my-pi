/**
 * Worktree lifecycle management.
 *
 * Handles creation and removal of task worktrees. Each task gets a
 * dedicated branch (`task/<slug>`) and a worktree directory inside
 * a sibling `<repo>-worktrees/` folder.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";

import {
  branchExists,
  getMainBranch,
  getRepositoryRoot,
  mergeBranch,
  worktreeList,
} from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { createWorkspace, destroyWorkspace } from "../../lib/workspace.js";
import {
  type HarnessState,
  MAX_SLUG_LENGTH,
  TASK_BRANCH_PREFIX,
  type TaskState,
  WORKTREE_DIR_SUFFIX,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random hex string for use as a task ID. */
function generateTaskId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Convert a human description into a branch-safe slug.
 *
 * Lowercases, replaces non-alphanumeric runs with hyphens,
 * strips leading/trailing hyphens, and truncates.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Derive the worktree base directory from the repository root.
 *
 * Given `/home/user/projects/my-app`, returns
 * `/home/user/projects/my-app-worktrees`.
 */
export function getWorktreeBaseDir(repoRoot: string): string {
  return `${repoRoot}${WORKTREE_DIR_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new task: branch from main, set up a worktree, return state.
 *
 * The worktree is placed at `<repo>-worktrees/<slug>/`.
 * Fails if the derived branch name already exists.
 *
 * @param ctx         - Git context pointing at the **main** worktree.
 * @param description - Human-readable description of the task.
 */
export async function createTask(
  ctx: GitContext,
  description: string,
): Promise<Result<TaskState>> {
  const repoRoot = await getRepositoryRoot(ctx);
  if (!repoRoot.ok) return repoRoot;

  const mainBranch = await getMainBranch(ctx);
  if (!mainBranch.ok) return mainBranch;

  const slug = slugify(description);
  if (slug.length === 0) {
    return { ok: false, error: "Description must contain at least one alphanumeric character" };
  }

  const branchName = `${TASK_BRANCH_PREFIX}${slug}`;

  const exists = await branchExists(ctx, branchName);
  if (!exists.ok) return exists;
  if (exists.value) {
    return { ok: false, error: `Branch '${branchName}' already exists. Use a different description.` };
  }

  const baseDir = getWorktreeBaseDir(repoRoot.value);
  const worktreePath = path.join(baseDir, slug);

  const workspaceResult = await createWorkspace(ctx, {
    worktreePath,
    branchName,
    baseBranch: mainBranch.value,
  });
  if (!workspaceResult.ok) return workspaceResult;

  const task: TaskState = {
    id: generateTaskId(),
    description,
    branchName,
    worktreePath,
    checkpoints: [],
    status: "active",
    createdAt: Date.now(),
  };

  return { ok: true, value: task };
}

/**
 * Remove a task's worktree and branch.
 *
 * @param ctx  - Git context pointing at the **main** worktree.
 * @param task - The task to clean up.
 */
export async function removeTask(ctx: GitContext, task: TaskState): Promise<Result<void>> {
  return destroyWorkspace(ctx, task);
}

/** Look up the currently active task, or null if none. */
export function getActiveTask(state: HarnessState): TaskState | null {
  if (!state.activeTaskId) return null;
  return state.tasks.get(state.activeTaskId) ?? null;
}

/**
 * Update a task branch by merging the latest main into it.
 *
 * If the task worktree has uncommitted changes, they must be
 * checkpointed by the caller before calling this function.
 * This function only performs the merge.
 *
 * @param mainCtx - Git context pointing at the **main** worktree.
 * @param taskCtx - Git context pointing at the **task** worktree.
 */
export async function updateTaskFromMain(
  mainCtx: GitContext,
  taskCtx: GitContext,
): Promise<Result<string>> {
  const mainBranch = await getMainBranch(mainCtx);
  if (!mainBranch.ok) return mainBranch;

  return mergeBranch(taskCtx, mainBranch.value);
}

/**
 * Discover task worktrees from git that aren't already tracked in state.
 *
 * Scans `git worktree list` for branches matching the `task/` prefix
 * and creates TaskState entries for any that the session doesn't know
 * about. This allows a new pi instance to pick up worktrees created
 * by another session.
 *
 * @param ctx   - Git context pointing at the **main** worktree.
 * @param state - Current harness state (mutated in place with new tasks).
 * @returns Number of newly discovered tasks.
 */
export async function discoverTasksFromGit(
  ctx: GitContext,
  state: HarnessState,
): Promise<Result<number>> {
  const worktrees = await worktreeList(ctx);
  if (!worktrees.ok) return worktrees;

  const knownPaths = new Set(
    Array.from(state.tasks.values()).map((t) => t.worktreePath),
  );

  let discoveredCount = 0;

  for (const wt of worktrees.value) {
    if (wt.isMainWorktree) continue;
    if (!wt.branch?.startsWith(TASK_BRANCH_PREFIX)) continue;
    if (knownPaths.has(wt.path)) continue;

    // Derive a description from the branch name slug
    const slug = wt.branch.slice(TASK_BRANCH_PREFIX.length);
    const description = slug.replace(/-/g, " ");

    const task: TaskState = {
      id: generateTaskId(),
      description,
      branchName: wt.branch,
      worktreePath: wt.path,
      checkpoints: [],
      status: "active",
      createdAt: Date.now(),
    };

    state.tasks.set(task.id, task);
    discoveredCount++;
  }

  return { ok: true, value: discoveredCount };
}
