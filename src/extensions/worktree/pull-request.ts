/**
 * GitHub pull request creation via the `gh` CLI.
 *
 * Separated from git operations because `gh` is the GitHub CLI,
 * not a git command. Uses the same {@link GitContext} for execution
 * and working directory.
 */

import type { GitContext, Result } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a successful PR creation. */
export interface PullRequestInfo {
  /** The PR URL returned by `gh pr create`. */
  url: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a GitHub pull request for the current branch.
 *
 * @param ctx        - Git context (used for cwd and exec).
 * @param branchName - The branch to open the PR from.
 * @param options    - PR creation options.
 */
export async function createPullRequest(
  ctx: GitContext,
  branchName: string,
  options: { title: string; body?: string; baseBranch: string },
): Promise<Result<PullRequestInfo>> {
  const args = [
    "-C", ctx.cwd,
    "pr", "create",
    "--title", options.title,
    "--base", options.baseBranch,
    "--head", branchName,
  ];

  if (options.body) {
    args.push("--body", options.body);
  } else {
    args.push("--body", "");
  }

  const result = await ctx.exec("gh", args, { timeout: 30_000 });

  if (result.code !== 0) {
    const stderr = result.stderr.trim();

    if (stderr.includes("already exists")) {
      return { ok: false, error: "A pull request already exists for this branch." };
    }

    return { ok: false, error: `gh pr create failed: ${stderr}` };
  }

  const url = result.stdout.trim();
  return { ok: true, value: { url } };
}
