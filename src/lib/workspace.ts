/**
 * Shared git-workspace primitives.
 *
 * A {@link Workspace} is a git branch + worktree pair derived from a
 * base branch. Both the single-task worktree extension and the
 * multi-agent team extension operate on workspaces; this module
 * centralises create / destroy / rebase / squash-merge so both
 * callers stay consistent.
 *
 * All functions take an explicit {@link GitContext} so the caller
 * controls which repository root the git commands run in.
 */

import {
  abortMerge,
  commit,
  createBranch,
  deleteBranch,
  getCurrentBranch,
  getMergeConflicts,
  hasUncommittedChanges,
  mergeBranch,
  mergeSquash,
  resetHard,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "./git.js";
import type { GitContext, Result } from "./types.js";

/** Structured error for rebase failures that includes conflicting file paths. */
export interface RebaseConflictError {
  message: string;
  conflictPaths: string[];
}

/** A git worktree checked out on its own branch, forked from a base branch. */
export interface Workspace {
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** Branch name pointing at the worktree (e.g., `task/foo`, `team/abc/worker-1`). */
  branchName: string;
  /** Base branch the workspace was forked from (e.g., `main`). */
  baseBranch: string;
}

// ---------------------------------------------------------------------------
// Create / destroy
// ---------------------------------------------------------------------------

export interface CreateWorkspaceRequest {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}

/**
 * Create a new workspace: branch off {@link CreateWorkspaceRequest.baseBranch},
 * then add a worktree at {@link CreateWorkspaceRequest.worktreePath}. If the
 * worktree-add step fails, the branch is deleted so retrying is safe.
 */
export async function createWorkspace(
  git: GitContext,
  req: CreateWorkspaceRequest,
): Promise<Result<Workspace>> {
  const branchResult = await createBranch(git, req.branchName, req.baseBranch);
  if (!branchResult.ok) return branchResult;

  const worktreeResult = await worktreeAdd(git, req.worktreePath, req.branchName);
  if (!worktreeResult.ok) {
    await deleteBranch(git, req.branchName);
    return worktreeResult;
  }

  return {
    ok: true,
    value: {
      worktreePath: req.worktreePath,
      branchName: req.branchName,
      baseBranch: req.baseBranch,
    },
  };
}

/**
 * Remove a workspace's worktree and branch.
 *
 * Runs {@link worktreePrune} first so stale metadata from previously
 * deleted directories doesn't make git refuse. Returns the first
 * error encountered; callers that treat this as cleanup and don't
 * care about partial failures can ignore the returned Result.
 */
export async function destroyWorkspace(
  git: GitContext,
  ws: Pick<Workspace, "worktreePath" | "branchName">,
): Promise<Result<void>> {
  await worktreePrune(git);

  const worktreeResult = await worktreeRemove(git, ws.worktreePath);
  if (!worktreeResult.ok) return worktreeResult;

  return deleteBranch(git, ws.branchName);
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

/**
 * Update a workspace branch to include the latest state of its base branch.
 *
 * Merges {@link baseBranch} into the workspace (a real merge commit, not
 * a rebase — preserves worker history). If the merge conflicts, aborts
 * cleanly and returns an error listing the conflicting files.
 *
 * After a successful rebase, the workspace branch is a descendant of
 * {@link baseBranch}'s current HEAD, making the subsequent squash-merge
 * trivial (no three-way surprises).
 *
 * @param workspaceGit - Git context rooted at the worker's worktree.
 * @param baseBranch   - Branch to merge in (e.g., the team's target branch).
 */
export async function rebaseWorkspace(
  workspaceGit: GitContext,
  baseBranch: string,
): Promise<Result<void, RebaseConflictError>> {
  const update = await mergeBranch(workspaceGit, baseBranch);
  if (update.ok) {
    return { ok: true, value: undefined };
  }

  // Merge failed — likely conflicts. Grab the file list before aborting.
  const conflicts = await getMergeConflicts(workspaceGit);
  await abortMerge(workspaceGit);
  const conflictPaths = conflicts.ok ? conflicts.value : [];
  const files = conflictPaths.length > 0 ? conflictPaths.join(", ") : "unknown files";
  return {
    ok: false,
    error: {
      message: `Rebase conflicts on: ${files}`,
      conflictPaths,
    },
  };
}

// ---------------------------------------------------------------------------
// Squash merge
// ---------------------------------------------------------------------------

export interface SquashMergeOptions {
  /** Commit message applied after the squash. */
  commitMessage: string;
}

/** Outcome of a successful squash merge. */
export type SquashMergeValue =
  | { kind: "merged"; commitSha: string }
  /** The squash completed but introduced no changes (workspace had no net commits). */
  | { kind: "noop" };

/**
 * Squash-merge a workspace branch into its base branch.
 *
 * Preconditions:
 *   - The workspace branch has already been rebased onto the base branch
 *     via {@link rebaseWorkspace}. This makes the squash a trivial delta
 *     application with no three-way merge surprises.
 *   - {@link baseGit}'s current branch equals {@link Workspace.baseBranch}.
 *   - The base working tree is clean.
 *
 * On success, returns {@link SquashMergeValue} carrying either the merge
 * commit SHA or `noop` when the workspace had no net changes.
 */
export async function squashMergeWorkspace(
  baseGit: GitContext,
  ws: Workspace,
  options: SquashMergeOptions,
): Promise<Result<SquashMergeValue>> {
  const preconditionCheck = await ensureMergeReady(baseGit, ws.baseBranch);
  if (!preconditionCheck.ok) return preconditionCheck;

  const squash = await mergeSquash(baseGit, ws.branchName);
  if (!squash.ok) {
    await resetHard(baseGit);
    return { ok: false, error: squash.error };
  }

  return await finalizeSquash(baseGit, options.commitMessage);
}

/** Verify the base branch is checked out and clean before starting a merge. */
async function ensureMergeReady(baseGit: GitContext, baseBranch: string): Promise<Result<void>> {
  const currentBranch = await getCurrentBranch(baseGit);
  if (!currentBranch.ok) return currentBranch;
  if (currentBranch.value !== baseBranch) {
    return {
      ok: false,
      error: `Expected base branch '${baseBranch}' but repo is on '${currentBranch.value}'. Cannot merge.`,
    };
  }

  const dirty = await hasUncommittedChanges(baseGit);
  if (!dirty.ok) return dirty;
  if (dirty.value) {
    return {
      ok: false,
      error: `Base branch '${baseBranch}' has uncommitted changes. Commit or stash them before merging.`,
    };
  }

  return { ok: true, value: undefined };
}

/** Commit the squashed tree (or report a no-op if the squash introduced no changes). */
async function finalizeSquash(
  baseGit: GitContext,
  message: string,
): Promise<Result<SquashMergeValue>> {
  const dirty = await hasUncommittedChanges(baseGit);
  if (!dirty.ok) return dirty;
  if (!dirty.value) {
    return { ok: true, value: { kind: "noop" } };
  }
  const commitResult = await commit(baseGit, message);
  if (!commitResult.ok) return commitResult;
  return { ok: true, value: { kind: "merged", commitSha: commitResult.value } };
}
