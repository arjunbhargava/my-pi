/**
 * Shared helpers for building rich git commit messages.
 *
 * Used by both the worktree extension (per-turn checkpoints + squash
 * accept) and the team extension (worker complete_task auto-commit +
 * evaluator close_task merge commit) so every commit that lands on a
 * user's branch reads the same way regardless of which path produced it.
 *
 * The output format is deliberately plain:
 *
 *     <subject>
 *
 *     Heading:
 *     - bulleted item
 *     - bulleted item
 *
 *     Another heading:
 *     <multi-line body paragraph>
 *
 * — readable in `git log --oneline` (subject only) and `git show` alike.
 */

import type { DiffFileEntry, DiffStatus } from "./git.js";

/**
 * A captioned block of content in a commit body.
 *
 * Use `items` for short one-liners (rendered as a bullet list) and
 * `body` for multi-line paragraphs (rendered verbatim). Exactly one
 * of the two must be present; use whichever matches the content best.
 */
export type CommitSection =
  | { heading: string; items: string[] }
  | { heading: string; body: string };

/**
 * Assemble a commit message from a subject and optional sections.
 * Empty sections (no items, or whitespace-only body) are skipped.
 * A single trailing newline is appended.
 */
export function composeCommitMessage(subject: string, sections: CommitSection[]): string {
  const lines: string[] = [subject.trim()];

  for (const section of sections) {
    if ("items" in section) {
      if (section.items.length === 0) continue;
      lines.push("", `${section.heading}:`);
      for (const item of section.items) lines.push(`- ${item}`);
    } else {
      const body = section.body.trim();
      if (body.length === 0) continue;
      lines.push("", `${section.heading}:`, body);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Human-readable verb for a diff status letter. */
const STATUS_LABELS: Record<DiffStatus, string> = {
  A: "add",
  M: "modify",
  D: "delete",
  R: "rename",
  C: "copy",
  T: "change type",
};

/** Render one {@link DiffFileEntry} as a human-readable single line. */
export function formatFileChange(entry: DiffFileEntry): string {
  const label = STATUS_LABELS[entry.status] ?? entry.status;
  if (entry.renamedTo) return `${label} ${entry.path} → ${entry.renamedTo}`;
  return `${label} ${entry.path}`;
}

/** Batch formatter, suitable as the `items` of a "Changes" section. */
export function formatFileChanges(entries: DiffFileEntry[]): string[] {
  return entries.map(formatFileChange);
}

/**
 * First non-empty line of `text`, trimmed and capped at `maxChars`.
 * Produces a safe subject-length summary for arbitrary prompt text.
 */
export function firstLineSummary(text: string, maxChars = 120): string {
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + "…";
}
