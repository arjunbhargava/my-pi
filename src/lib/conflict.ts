/**
 * Conflict classification for rebase failures.
 *
 * Distinguishes "textual" conflicts (a fresh checkout from HEAD will
 * resolve them) from "structural" conflicts (the files the task
 * targets were deleted, renamed, or substantially rewritten on the
 * target branch — retrying won't help without re-scoping).
 *
 * Used by the evaluator's wait_to_evaluate rebase step to decide
 * whether to auto-reject (textual) or surface to the model for
 * resolution (structural).
 */

import {
  diffNameStatusBetween,
  diffNumstat,
  type DiffFileEntry,
  type DiffNumstatEntry,
} from "./git.js";
import type { GitContext, Result } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a conflicting file was changed on the target branch. */
export type FileChangeKind =
  | "deleted"
  | "renamed"
  | "rewritten"
  | "minor-edit";

/** Classification result for a single conflicting file. */
export interface ConflictFileDetail {
  /** Original path that conflicted. */
  path: string;
  /** What happened to this file on the target branch since baseSha. */
  change: FileChangeKind;
  /** New path if the file was renamed/moved. */
  renamedTo?: string;
  /** Fraction of lines changed (added+removed / original size), 0-1. */
  changeRatio?: number;
}

/** Overall classification of a set of rebase conflicts. */
export type ConflictClassification =
  | { kind: "textual" }
  | { kind: "structural"; files: ConflictFileDetail[] };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * If the ratio of changed lines to original file size exceeds this
 * threshold, the file is considered "rewritten" (structural change).
 * 0.6 = more than 60% of lines added or removed.
 */
const REWRITE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a set of conflicting file paths as textual or structural.
 *
 * Compares each conflicting file between `baseSha` (when the task
 * branched) and the current `targetRef` (where the target branch is
 * now). If any conflicting file was deleted, renamed, or rewritten
 * beyond {@link REWRITE_THRESHOLD}, the conflict set is structural.
 *
 * @param git           - Git context rooted at the main repository.
 * @param baseSha       - Commit the task's workspace branched from.
 * @param targetRef     - Current HEAD of the target branch.
 * @param conflictPaths - File paths reported by git as conflicting.
 */
export async function classifyConflicts(
  git: GitContext,
  baseSha: string,
  targetRef: string,
  conflictPaths: string[],
): Promise<Result<ConflictClassification>> {
  if (conflictPaths.length === 0) {
    return { ok: true, value: { kind: "textual" } };
  }

  // Get name-status (with rename detection) for the conflicting paths.
  const statusResult = await diffNameStatusBetween(git, baseSha, targetRef, conflictPaths);
  if (!statusResult.ok) {
    return { ok: false, error: statusResult.error };
  }

  // Get numstat for change ratio calculation.
  const numstatResult = await diffNumstat(git, baseSha, targetRef, conflictPaths);
  const numstatMap = buildNumstatMap(numstatResult);

  const structuralFiles: ConflictFileDetail[] = [];

  for (const filePath of conflictPaths) {
    const detail = classifyFile(filePath, statusResult.value, numstatMap);
    if (detail.change !== "minor-edit") {
      structuralFiles.push(detail);
    }
  }

  if (structuralFiles.length === 0) {
    return { ok: true, value: { kind: "textual" } };
  }

  return { ok: true, value: { kind: "structural", files: structuralFiles } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a path → numstat lookup from the diff result. */
function buildNumstatMap(
  result: Result<DiffNumstatEntry[]>,
): Map<string, DiffNumstatEntry> {
  const map = new Map<string, DiffNumstatEntry>();
  if (!result.ok) return map;
  for (const entry of result.value) {
    map.set(entry.path, entry);
  }
  return map;
}

/** Classify a single file based on its name-status and numstat data. */
function classifyFile(
  filePath: string,
  statusEntries: DiffFileEntry[],
  numstatMap: Map<string, DiffNumstatEntry>,
): ConflictFileDetail {
  // Check if the file appears in the name-status output.
  const entry = statusEntries.find((e) => e.path === filePath);

  if (!entry) {
    // File not in the two-dot diff at all — might have been renamed
    // FROM this path (check if any entry has this as a rename source).
    const renameEntry = statusEntries.find(
      (e) => e.status === "R" && e.path === filePath,
    );
    if (renameEntry) {
      return { path: filePath, change: "renamed", renamedTo: renameEntry.renamedTo };
    }
    // Not modified on target branch — conflict is purely textual
    // (e.g., both branches added content at the same location).
    return { path: filePath, change: "minor-edit" };
  }

  if (entry.status === "D") {
    return { path: filePath, change: "deleted" };
  }

  if (entry.status === "R") {
    return { path: filePath, change: "renamed", renamedTo: entry.renamedTo };
  }

  // File was modified — check the change ratio.
  if (entry.status === "M") {
    const numstat = numstatMap.get(filePath);
    if (numstat) {
      const totalChanged = numstat.added + numstat.removed;
      // Use removed as proxy for original file size (lines that
      // existed at baseSha). If removed is 0, the file only had
      // additions — that's not a rewrite.
      const originalSize = numstat.removed > 0 ? numstat.removed : totalChanged;
      const ratio = originalSize > 0 ? totalChanged / (originalSize + numstat.added) : 0;
      if (ratio >= REWRITE_THRESHOLD) {
        return { path: filePath, change: "rewritten", changeRatio: ratio };
      }
    }
  }

  return { path: filePath, change: "minor-edit" };
}

/**
 * Format structural conflict details into a human-readable summary
 * suitable for presenting to the evaluator model.
 */
export function formatConflictDetails(files: ConflictFileDetail[]): string {
  const lines: string[] = [];
  for (const f of files) {
    switch (f.change) {
      case "deleted":
        lines.push(`  - ${f.path}: DELETED on target branch`);
        break;
      case "renamed":
        lines.push(`  - ${f.path}: RENAMED → ${f.renamedTo ?? "(unknown destination)"}`);
        break;
      case "rewritten":
        lines.push(`  - ${f.path}: REWRITTEN (${Math.round((f.changeRatio ?? 0) * 100)}% of lines changed)`);
        break;
    }
  }
  return lines.join("\n");
}
