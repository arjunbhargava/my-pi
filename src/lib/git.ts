/**
 * Thin wrappers around git CLI commands.
 *
 * Every function accepts a {@link GitContext} and returns a typed
 * {@link Result}. No function has side effects beyond the git command
 * it executes. All path arguments are absolute.
 *
 * This is the *only* module that should invoke git directly.
 */

import type {
  ExecResult,
  FileStatus,
  GitContext,
  Result,
  WorktreeInfo,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 15_000;

/** Run a git command with `-C <cwd>` so it operates in the right directory. */
async function execGit(
  ctx: GitContext,
  args: string[],
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  return ctx.exec("git", ["-C", ctx.cwd, ...args], { timeout: timeoutMs });
}

/** Strip the `refs/heads/` prefix from a fully-qualified branch ref. */
function stripRefsPrefix(ref: string): string {
  const PREFIX = "refs/heads/";
  return ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : ref;
}

// ---------------------------------------------------------------------------
// Repository info
// ---------------------------------------------------------------------------

/** Return the absolute path to the repository root, or an error if not in a repo. */
export async function getRepositoryRoot(ctx: GitContext): Promise<Result<string>> {
  const result = await execGit(ctx, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    return { ok: false, error: `Not a git repository: ${result.stderr.trim()}` };
  }
  return { ok: true, value: result.stdout.trim() };
}

/** Return the name of the currently checked-out branch, or an error if detached. */
export async function getCurrentBranch(ctx: GitContext): Promise<Result<string>> {
  const result = await execGit(ctx, ["symbolic-ref", "--short", "HEAD"]);
  if (result.code !== 0) {
    return { ok: false, error: "HEAD is detached or not on a branch" };
  }
  return { ok: true, value: result.stdout.trim() };
}

/**
 * Detect the main integration branch (`main` or `master`).
 * Checks for existing local branches first, then falls back to the
 * `init.defaultBranch` git config value.
 */
export async function getMainBranch(ctx: GitContext): Promise<Result<string>> {
  for (const candidate of ["main", "master"]) {
    const check = await execGit(ctx, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
    if (check.code === 0) return { ok: true, value: candidate };
  }

  const config = await execGit(ctx, ["config", "--get", "init.defaultBranch"]);
  if (config.code === 0 && config.stdout.trim()) {
    return { ok: true, value: config.stdout.trim() };
  }

  return { ok: false, error: "Could not determine main branch (no main/master found)" };
}

/** Return the full SHA of HEAD. */
export async function getHeadSha(ctx: GitContext): Promise<Result<string>> {
  const result = await execGit(ctx, ["rev-parse", "HEAD"]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to read HEAD: ${result.stderr.trim()}` };
  }
  return { ok: true, value: result.stdout.trim() };
}

// ---------------------------------------------------------------------------
// Working tree status
// ---------------------------------------------------------------------------

/** Return true if there are uncommitted changes (staged or unstaged). */
export async function hasUncommittedChanges(ctx: GitContext): Promise<Result<boolean>> {
  const result = await execGit(ctx, ["status", "--porcelain=v1"]);
  if (result.code !== 0) {
    return { ok: false, error: `git status failed: ${result.stderr.trim()}` };
  }
  return { ok: true, value: result.stdout.trim().length > 0 };
}

/** Parse `git status --porcelain=v1` into structured file entries. */
export async function getStatus(ctx: GitContext): Promise<Result<FileStatus[]>> {
  const result = await execGit(ctx, ["status", "--porcelain=v1"]);
  if (result.code !== 0) {
    return { ok: false, error: `git status failed: ${result.stderr.trim()}` };
  }

  const files: FileStatus[] = result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({
      indexStatus: line[0],
      workingTreeStatus: line[1],
      path: line.slice(3),
    }));

  return { ok: true, value: files };
}

// ---------------------------------------------------------------------------
// Staging and committing
// ---------------------------------------------------------------------------

/** Stage all changes (tracked and untracked) in the working tree. */
export async function stageAll(ctx: GitContext): Promise<Result<void>> {
  const result = await execGit(ctx, ["add", "-A"]);
  if (result.code !== 0) {
    return { ok: false, error: `git add failed: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/**
 * Create a commit with the given message.
 * Returns the SHA of the new commit.
 * Fails if there is nothing staged.
 */
export async function commit(ctx: GitContext, message: string): Promise<Result<string>> {
  const result = await execGit(ctx, ["commit", "-m", message]);
  if (result.code !== 0) {
    return { ok: false, error: `git commit failed: ${result.stderr.trim()}` };
  }

  const sha = await getHeadSha(ctx);
  return sha;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/** Return true if a local branch with the given name exists. */
export async function branchExists(ctx: GitContext, name: string): Promise<Result<boolean>> {
  const result = await execGit(ctx, ["rev-parse", "--verify", `refs/heads/${name}`]);
  return { ok: true, value: result.code === 0 };
}

/** Create a new branch at the given start point (defaults to HEAD). */
export async function createBranch(
  ctx: GitContext,
  name: string,
  startPoint?: string,
): Promise<Result<void>> {
  const args = ["branch", name];
  if (startPoint) args.push(startPoint);

  const result = await execGit(ctx, args);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to create branch '${name}': ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/** Force-delete a local branch. */
export async function deleteBranch(ctx: GitContext, name: string): Promise<Result<void>> {
  const result = await execGit(ctx, ["branch", "-D", name]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to delete branch '${name}': ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

/**
 * Create a new worktree at `worktreePath` on `branchName`.
 * The branch must already exist.
 */
export async function worktreeAdd(
  ctx: GitContext,
  worktreePath: string,
  branchName: string,
): Promise<Result<void>> {
  const result = await execGit(ctx, ["worktree", "add", worktreePath, branchName]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to add worktree: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/** Remove a worktree. Uses `--force` to handle dirty trees. */
export async function worktreeRemove(
  ctx: GitContext,
  worktreePath: string,
): Promise<Result<void>> {
  const result = await execGit(ctx, ["worktree", "remove", "--force", worktreePath]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to remove worktree: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/** Parse the output of `git worktree list --porcelain` into structured entries. */
export async function worktreeList(ctx: GitContext): Promise<Result<WorktreeInfo[]>> {
  const result = await execGit(ctx, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to list worktrees: ${result.stderr.trim()}` };
  }

  const worktrees: WorktreeInfo[] = [];
  const blocks = result.stdout.split("\n\n").filter((block) => block.trim().length > 0);

  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let head = "";
    let branch: string | null = null;
    let isMainWorktree = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
        // The first worktree entry is always the main worktree
        isMainWorktree = worktrees.length === 0;
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = stripRefsPrefix(line.slice("branch ".length));
      }
    }

    if (path && head) {
      worktrees.push({ path, head, branch, isMainWorktree });
    }
  }

  return { ok: true, value: worktrees };
}

/** Clean up stale worktree metadata (e.g., after manually deleting a directory). */
export async function worktreePrune(ctx: GitContext): Promise<Result<void>> {
  const result = await execGit(ctx, ["worktree", "prune"]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to prune worktrees: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

/**
 * Push a branch to the remote, setting upstream tracking.
 *
 * @param ctx    - Git context.
 * @param branch - Local branch name to push.
 * @param remote - Remote name (defaults to "origin").
 * @param force  - If true, force-push with lease.
 */
export async function pushBranch(
  ctx: GitContext,
  branch: string,
  options?: { remote?: string; force?: boolean },
): Promise<Result<void>> {
  const remote = options?.remote ?? "origin";
  const args = ["push", "-u", remote, branch];
  if (options?.force) args.splice(1, 0, "--force-with-lease");

  const result = await execGit(ctx, args, 30_000);
  if (result.code !== 0) {
    return { ok: false, error: `git push failed: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Squash-merge the given branch into the currently checked-out branch.
 * Stages the result but does NOT commit — the caller must commit separately
 * so it can control the commit message.
 */
export async function mergeSquash(ctx: GitContext, branchName: string): Promise<Result<void>> {
  const result = await execGit(ctx, ["merge", "--squash", branchName]);
  if (result.code !== 0) {
    return { ok: false, error: `Squash merge failed: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/**
 * Get one-line log entries between two refs (exclusive fromRef, inclusive toRef).
 *
 * @param ctx     - Git context.
 * @param fromRef - Ancestor ref (exclusive).
 * @param toRef   - Descendant ref (inclusive).
 * @returns Array of `{ sha, subject }` objects, newest first.
 */
export async function logOneline(
  ctx: GitContext,
  fromRef: string,
  toRef: string,
): Promise<Result<Array<{ sha: string; subject: string }>>> {
  const result = await execGit(ctx, [
    "log",
    "--oneline",
    "--format=%H %s",
    `${fromRef}..${toRef}`,
  ]);
  if (result.code !== 0) {
    return { ok: false, error: `git log failed: ${result.stderr.trim()}` };
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const entries = lines.map((line) => {
    const spaceIdx = line.indexOf(" ");
    return {
      sha: line.slice(0, spaceIdx),
      subject: line.slice(spaceIdx + 1),
    };
  });
  return { ok: true, value: entries };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Return a compact summary of differences between two refs (or HEAD). */
export async function diffSummary(
  ctx: GitContext,
  fromRef: string,
  toRef?: string,
): Promise<Result<string>> {
  const args = ["diff", "--stat", fromRef];
  if (toRef) args.push(toRef);

  const result = await execGit(ctx, args);
  if (result.code !== 0) {
    return { ok: false, error: `git diff failed: ${result.stderr.trim()}` };
  }
  return { ok: true, value: result.stdout.trim() };
}
