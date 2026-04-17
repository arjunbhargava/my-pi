/**
 * Checkpoint logic for the worktree extension.
 *
 * A checkpoint is a commit on the task branch that captures the state
 * of the worktree after an agent interaction. The git history itself
 * serves as the "before" reference — each checkpoint's parent is the
 * previous checkpoint (or the branch point from main).
 */

import { commit, hasUncommittedChanges, stageAll } from "../../lib/git.js";
import type { GitContext, Result } from "../../lib/types.js";
import { CHECKPOINT_PREFIX, type CheckpointRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Commit messages longer than this are truncated with an ellipsis. */
const MAX_COMMIT_SUBJECT_LENGTH = 72;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a commit message from a user prompt or description.
 * Uses the first line of the description, truncated to fit in a
 * standard git subject line.
 */
function formatCommitMessage(description: string): string {
  const firstLine = description.split("\n")[0].trim();
  const subject =
    firstLine.length <= MAX_COMMIT_SUBJECT_LENGTH
      ? firstLine
      : firstLine.slice(0, MAX_COMMIT_SUBJECT_LENGTH - 3) + "...";

  return `${CHECKPOINT_PREFIX} ${subject}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage all changes in the worktree and commit them as a checkpoint.
 *
 * Returns `null` inside the Result if there are no changes to commit
 * (this is not an error — it just means the agent didn't modify files).
 *
 * @param ctx      - Git context pointing at the task worktree.
 * @param description - Human-readable description (typically the user's prompt).
 */
export async function createCheckpoint(
  ctx: GitContext,
  description: string,
): Promise<Result<CheckpointRecord | null>> {
  const dirtyCheck = await hasUncommittedChanges(ctx);
  if (!dirtyCheck.ok) return dirtyCheck;

  if (!dirtyCheck.value) {
    return { ok: true, value: null };
  }

  const stageResult = await stageAll(ctx);
  if (!stageResult.ok) return stageResult;

  const message = formatCommitMessage(description);
  const commitResult = await commit(ctx, message);
  if (!commitResult.ok) return commitResult;

  const record: CheckpointRecord = {
    sha: commitResult.value,
    description,
    timestamp: Date.now(),
  };

  return { ok: true, value: record };
}
