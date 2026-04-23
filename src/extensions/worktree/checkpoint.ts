/**
 * Checkpoint logic for the worktree extension.
 *
 * A checkpoint is a commit on the task branch that captures the state
 * of the worktree after an agent interaction. The git history itself
 * serves as the "before" reference — each checkpoint's parent is the
 * previous checkpoint (or the branch point from main).
 */

import {
  commit,
  diffStaged,
  hasUncommittedChanges,
  stageAll,
} from "../../lib/git.js";
import {
  composeCommitMessage,
  formatFileChanges,
} from "../../lib/commit-message.js";
import type { GitContext, Result } from "../../lib/types.js";
import { CHECKPOINT_PREFIX, type CheckpointRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Condense a raw user prompt into a clean commit message.
 *
 * Strips filler words, collapses whitespace, lowercases, and produces
 * a description that reads as "what changed" rather than echoing the
 * verbatim request. The full prompt is preserved in the commit body
 * for traceability.
 */
export function summarizePrompt(rawPrompt: string): string {
  // Collapse whitespace and take meaningful content
  const collapsed = rawPrompt.replace(/\s+/g, " ").trim();

  // Strip common conversational prefixes
  const cleaned = collapsed
    .replace(/^(please|can you|could you|i want you to|go ahead and|let'?s|now|also|ok|hey|hi)\s+/i, "")
    .replace(/^(make sure (that|to)?|i need you to|i'd like you to)\s+/i, "")
    .trim();

  // Lowercase the first character for commit-message style
  const summary = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);

  // Strip trailing period — commit messages don't end with one
  return summary.replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage all changes in the worktree and commit them as a checkpoint.
 *
 * The commit message carries both the original prompt (for traceability)
 * and the list of files touched, so `git log` of the task branch reads
 * like a timeline of (prompt, effect) pairs.
 *
 * Returns `null` inside the Result if there are no changes to commit
 * (this is not an error — it just means the agent didn't modify files).
 *
 * @param ctx         - Git context pointing at the task worktree.
 * @param description - Human-readable description (typically the user's prompt).
 */
export async function createCheckpoint(
  ctx: GitContext,
  description: string,
): Promise<Result<CheckpointRecord | null>> {
  const dirtyCheck = await hasUncommittedChanges(ctx);
  if (!dirtyCheck.ok) return dirtyCheck;
  if (!dirtyCheck.value) return { ok: true, value: null };

  const stageResult = await stageAll(ctx);
  if (!stageResult.ok) return stageResult;

  // Capture the file list AFTER staging so the commit message reflects
  // exactly what this commit will record.
  const stagedFiles = await diffStaged(ctx);
  const fileItems = stagedFiles.ok ? formatFileChanges(stagedFiles.value) : [];

  const subject = `${CHECKPOINT_PREFIX} ${summarizePrompt(description)}`;
  const message = composeCommitMessage(subject, [
    { heading: "Prompt", body: description.trim() },
    { heading: "Changes", items: fileItems },
  ]);

  const commitResult = await commit(ctx, message);
  if (!commitResult.ok) return commitResult;

  return {
    ok: true,
    value: {
      sha: commitResult.value,
      description,
      timestamp: Date.now(),
    },
  };
}
