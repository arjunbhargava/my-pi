# Code Review: `src/lib/` — Shared Infrastructure

Reviewed all 8 modules. Findings below are per-module, then ranked by severity, then a dedicated assessment of `session-archive.ts` as a cross-session memory foundation.

---

## Per-Module Review

### 1. `git.ts` — 574 lines

**AGENTS.md violation: 574 lines exceeds the 400-line limit.** The module is logically coherent (all git commands in one place), but it needs splitting. A natural seam is the diff/log operations (roughly lines 400–574) into a `git-diff.ts` companion, leaving core ops (status, branch, worktree, merge) in `git.ts`.

**Type safety:**
- `src/lib/git.ts:565` — `parts[0].charAt(0) as DiffStatus` is an unsanitized cast. If `git diff --name-status` ever outputs an unrecognized status letter, the cast silently propagates an invalid `DiffStatus` into callers without any narrowing. Should validate against known letters or default to a catch-all.

**Error handling:** All failure paths are explicit; every non-zero exit code returns `{ ok: false, error }`. No silent swallows. The `diffNumstat` binary-file handling (`parts[0] === "-"`) is a deliberate guard documented inline — correct.

**Module boundary:** Fully adhered to. No other lib module calls `exec("git", ...)` directly. The "only git.ts runs git" rule holds across the entire `src/` tree.

**Function lengths:** All under 50 lines. `worktreeList` (the longest) is 40 lines and is dense-but-readable.

**Gap:** No `getFileAtBase` function that returns the full text of a file at a specific ref for diffing. `showFileAtRef` exists but only returns raw content; there's no structured "file blame" or "file history" wrapper. This becomes relevant for cross-session memory (see below).

---

### 2. `types.ts` — 196 lines

**Duplicate interface:** `GitContext` (line 35) and `ExecContext` (line 83) are structurally identical — both have `exec: ExecFn` and `cwd: string`. TypeScript's structural typing means either can substitute for the other, but the codebase carries both and the runtime explicitly instantiates both. The distinction is intentional (git vs. tmux contexts), but a single `ExecContext` with `ExecContext` aliased as `GitContext` would reduce confusion and prevent drift.

**`ClosedTask` loses the worker result:** On `closeTask`, the task's `result` field is discarded — only `id`, `title`, `closedBy`, `attempts`, and `closedAt` survive in the archive. There is no way to audit what a closed task produced. For short-term operations this is fine; for cross-session memory, the result string (worker output summary) is exactly the signal you'd want.

**No validation schema:** `TaskQueue` is typed but there's no runtime validation (no Zod, no TypeBox shape check). The type is used directly from `JSON.parse` in `readQueue`. Corrupted or schema-drifted queue files produce undefined behavior at runtime.

**Otherwise clean:** No `any`, no loose unions. Every field is documented with a JSDoc comment.

---

### 3. `task-queue.ts` — 411 lines

**AGENTS.md violation: 411 lines, marginally over the 400-line limit.** The natural split is extracting the query helpers (`getTasksByStatus`, `getNextQueuedTask`, `getTaskById`, `getQueueSummary`) into a `task-queue-queries.ts` companion.

**Type safety:**
- `src/lib/task-queue.ts:56` — `JSON.parse(raw) as TaskQueue` with no runtime validation. A missing `attempts` field (e.g., a queue written by an older version of the code) would not surface as a parse error; callers would get `undefined` where they expect a number.
- `src/lib/task-queue.ts:60` — `err as NodeJS.ErrnoException` requires `@types/node`, which is not in `devDependencies` (confirmed by `tsc --noEmit`; see [Missing `@types/node`](#missing-typesnode) below).

**Error handling:** All state-machine transitions (`dispatchTask`, `completeTask`, `closeTask`, `rejectTask`, `reviseTask`, `recoverTask`) enforce their preconditions with explicit `{ ok: false }` returns. No silent swallows. The `appendLog` trim is defensive and correct.

**`recoverTask` audit gap:** Recovery does not increment `attempts`. This is documented and intentional (the work was never completed), but the queue provides no way to count total dispatch attempts (including recoveries) for a task. If a task is repeatedly recovered due to crashes, the `attempts` counter stays low, giving a misleading impression of reliability.

---

### 4. `workspace.ts` — 227 lines

**Silently discarded `worktreePrune` failure:**
- `src/lib/workspace.ts:96` — `await worktreePrune(git)` — the result is discarded without logging. If `prune` fails, the subsequent `worktreeRemove` may also fail (stale metadata blocking the remove), making the error misleading. The comment acknowledges the discard but doesn't log. At minimum this should log a warning.

**Silent `abortMerge` failure in `rebaseWorkspace`:**
- `src/lib/workspace.ts:134` — `await abortMerge(workspaceGit)` — result discarded. If the abort fails, the worktree is left with a live `MERGE_HEAD`. Callers have no way to detect this. The function returns `{ ok: false, error: ... }` but the actual repository state may be broken. This should at minimum propagate the abort failure or document that the caller must handle a potentially stuck repo.

**Error handling otherwise clean:** `createWorkspace` rolls back the branch if `worktreeAdd` fails (verified by test). `squashMergeWorkspace` calls `resetHard` on merge failure. `ensureMergeReady` checks both branch identity and dirty state before starting.

**Function lengths:** All helpers (`ensureMergeReady`, `finalizeSquash`) are under 20 lines.

---

### 5. `commit-message.ts` — 90 lines

No issues. Clean, single-responsibility, well-tested (12 test cases in `tests/commit-message.test.ts`). The `CommitSection` discriminated union for `items` vs `body` is the right abstraction. All four exported functions are covered.

One minor note: `STATUS_LABELS` at runtime does not include status `"U"` (unmerged). This is not a bug because `DiffStatus` doesn't include `"U"` either — the cast in `git.ts:565` would need to be fixed first before this could arise. Non-blocking.

---

### 6. `conflict.ts` — 200 lines

**Critical bug: change ratio formula is mathematically degenerate.**

The intent (classify a file as "rewritten" if > 60% of its lines changed) is not achieved. At `src/lib/conflict.ts:165–174`:

```typescript
const totalChanged = numstat.added + numstat.removed;
const originalSize = numstat.removed > 0 ? numstat.removed : totalChanged;
const ratio = originalSize > 0 ? totalChanged / (originalSize + numstat.added) : 0;
```

When `numstat.removed > 0`:
- `originalSize = numstat.removed`
- `denominator = originalSize + numstat.added = numstat.removed + numstat.added = totalChanged`
- `ratio = totalChanged / totalChanged = 1.0` — **always 1.0, regardless of actual change magnitude**

Any file with even a single line removed is classified as "rewritten" (1.0 ≥ REWRITE_THRESHOLD 0.6). A 10,000-line file with 1 line changed gets the same ratio as a complete rewrite. The only way a modified file escapes "rewritten" is if it has zero removals (pure additions), which gives ratio = 0.5 via the fallback path.

**Correct formula** using the stated intent (removed lines as proxy for original size):
```typescript
const ratio = originalSize > 0 ? totalChanged / originalSize : 0;
// i.e.: totalChanged / numstat.removed
```
This still has weaknesses (original file size != lines removed) but at least produces values that scale with actual change density.

**Zero test coverage:** `conflict.ts` has no tests in `tests/` and is not listed in `scripts/test-unit.sh`. The bug above went undetected because there are no tests exercising the ratio calculation.

**Numstat failure path silently degrades:** At `src/lib/conflict.ts:93`, if `diffNumstat` fails, `buildNumstatMap` returns an empty map. All files with status `"M"` then have no numstat entry, so `classifyFile` never enters the ratio branch and always returns "minor-edit". A numstat failure would cause all structural "rewritten" files to be misclassified as textual conflicts.

---

### 7. `tmux.ts` — 208 lines

**`listWindows` parser does not validate field count:**
- `src/lib/tmux.ts:152–155` — `const [index, name, active, activity] = line.split("\t")`. If tmux outputs fewer fields than expected (e.g., a window name containing a tab, or a format string mismatch), `index` or `activity` will be `undefined`. `parseInt(undefined, 10)` returns `NaN` silently. The returned `TmuxWindow` objects would have `NaN` for `index` and `lastActivity`. Callers don't check for NaN.

**`sendKeys` always appends Enter:** The API unconditionally sends `"Enter"` after the keys string. This is fine for the current use case (sending shell commands) but makes the function unusable for sending bare key sequences without a newline. A `{ appendEnter?: boolean }` option would be straightforward to add.

**No automated tests:** `tests/tmux-spawn.test.ts` is a manual smoke test (not in `test-unit.sh`). The library functions (`sessionExists`, `listWindows`, `capturePane`, `createWindow`, etc.) have zero automated unit or integration test coverage.

**Module boundary:** Fully adhered to. All tmux invocations go through `execTmux`.

---

### 8. `session-archive.ts` — 273 lines

**`custom_message` silently drops non-string content:**
- `src/lib/session-archive.ts:178` — `if (typeof entry.content === "string" && entry.content.trim())`. If pi serializes `custom_message` content as an array (which `JsonlEntry.content` types as `unknown`), those entries are silently dropped with no fallback render. Whether pi ever does this is unconfirmed, but the defensive handling should cover both cases.

**`display` field parsed but ignored:** `JsonlEntry.display?: boolean` is declared but never checked. The renderer always outputs custom messages regardless of `display: false`. The existing comment justifies this ("display-suppressed context blocks carry useful system state"), so this is intentional — but it should be documented more explicitly to prevent a future developer from "fixing" it.

**Four bare `catch {}` blocks:** All are in file-listing/reading paths where "file disappeared between readdir and stat" is a valid race. They are correctly silent. No action needed.

**`parseSessionStartMs` return type is `number | null`:** The null is only returned for non-pi filenames. When callers use this as a time filter (`s.startMs === null ? true : s.startMs >= queue.createdAt`), `null` sessions pass the filter unconditionally, which could include unrelated sessions. Low risk in practice.

**Test coverage:** 7 tests in `tests/session-archive.test.ts` covering slug generation, filename parsing, mtime ordering, full render, malformed lines, and truncation. Coverage is good.

---

## Issues Ranked by Severity

### Critical

1. **`conflict.ts:165–174` — change ratio formula always returns 1.0 when `removed > 0`**
   - Impact: every file with any removed lines is classified as "rewritten". The textual/structural conflict distinction the evaluator relies on is broken for all modified-but-not-truly-rewritten files.
   - Fix: change denominator from `(originalSize + numstat.added)` to `originalSize`.

2. **`@types/node` missing from `devDependencies`/`tsconfig.json`**
   - Impact: `tsc --noEmit` reports 7 errors in `src/lib/` alone (`task-queue.ts`: 3 errors, `session-archive.ts`: 3 errors, `NodeJS` namespace: 1 error) and dozens more in extensions. The project cannot be type-checked cleanly.
   - Fix: `npm install --save-dev @types/node` and add `"types": ["node"]` to `tsconfig.json`.

### High

3. **`workspace.ts:134` — `abortMerge` failure silently discarded in `rebaseWorkspace`**
   - Impact: if `git merge --abort` fails, the worktree retains `MERGE_HEAD`. Subsequent git operations in that worktree will fail with confusing errors ("you have a merge in progress"). The caller gets `{ ok: false, error: "Rebase conflicts..." }` but no indication that cleanup failed.
   - Fix: propagate the abort failure or log it and document the invariant break.

4. **`conflict.ts` has zero test coverage**
   - Impact: the formula bug above (item 1) went undetected. The module is complex, actively used by the evaluator for critical routing decisions, and completely untested.
   - Fix: add `tests/conflict.test.ts` with real git repos, similar to `diff-name-status.test.ts`.

5. **`git.ts` (574 lines) and `task-queue.ts` (411 lines) violate the 400-line AGENTS.md limit**
   - Impact: not a runtime bug, but onboarding and incremental review become harder.
   - Fix: split `git.ts` at the diff/log boundary (~line 400); split `task-queue.ts` by extracting query helpers.

### Medium

6. **`tmux.ts:152–155` — `listWindows` parser does not guard against NaN fields**
   - Impact: if tmux output is malformed, `index` and `lastActivity` become `NaN`, propagating silently into callers (e.g., `dispatch.ts` uses window listings to detect hung workers).
   - Fix: validate field count before parsing; log and skip malformed lines.

7. **`task-queue.ts:56` / `session-archive.ts:145` — `JSON.parse as T` without runtime validation**
   - Impact: schema-drifted or partially-written files crash callers with obscure property-access errors rather than clean parse failures.
   - Fix: add a shallow validation (check required fields exist and have expected types) before the cast, or adopt TypeBox/Zod for queue shape validation.

8. **`workspace.ts:96` — `worktreePrune` failure silently discarded**
   - Impact: prune failures are rare but can cause downstream `worktreeRemove` to fail with a confusing "cannot remove" error rather than the real cause.
   - Fix: log on failure; or propagate if the caller should know.

9. **`GitContext` / `ExecContext` structural duplication in `types.ts`**
   - Impact: no runtime effect, but cognitive overhead and future drift risk.
   - Fix: `export type ExecContext = GitContext` (one fewer interface to maintain).

### Low

10. **`ClosedTask` discards `result` on close** — worker output is unrecoverable after task closure. No impact today, but blocks future audit/memory features.

11. **`tmux.ts` `sendKeys` hardcodes Enter** — limits reusability.

12. **`tmux.ts` has no automated tests** — lower risk than `conflict.ts` because the functions are thin wrappers, but a `listWindows` NaN regression would not be caught.

---

## `session-archive.ts` as a Cross-Session Memory Foundation

The module is well-built for its current scope (single-cwd session reading, transcript rendering) but has five gaps that prevent it from serving as a global history layer across repos.

### What works

- **JSONL format is append-only and parseable incrementally.** Each session is self-contained; `renderSessionToText` can handle any session without context from others.
- **Mtime ordering** in `listSessionFiles` gives a simple recency signal.
- **The slug function** (`sessionDirForCwd`) is deterministic and matches pi's own implementation, so all sessions for a given cwd are reliably locatable.
- **Tool calls, user messages, and assistant responses** are all preserved — enough raw signal to reconstruct what happened.

### What's missing for global memory

1. **No global session enumeration.** `listSessionFiles` takes a single `sessionDir`. There is no function that walks `~/.pi/agent/sessions/` and returns all sessions across all repos. Implementing this requires listing the sessions root and resolving each `--cwd-slug--` directory back to a cwd — which is the inverse of `sessionDirForCwd`. The inverse is currently not implemented and would require stripping the `--` wrapping and reversing the separator replacement.

2. **No structured extraction for machine consumption.** `renderSessionToText` produces human-readable text. For semantic search or a "what did I do in repo X last month" query, you'd need structured records (per-session: `{ cwd, startMs, toolCalls: [...], filesChanged: [...], decisions: [...] }`). No such extractor exists.

3. **No session-to-commit linkage.** Sessions don't record which git commits they produced. Answering "what was the context behind commit `abc123`?" requires correlating session timestamps against `git log --format="%H %ai"` — possible but not wired up.

4. **No index or cache.** Scanning hundreds of JSONL files cold is slow. A lightweight SQLite or flat-JSON index (session path → `{ cwd, startMs, toolNames[], filePaths[] }`) would make global memory queries fast without loading full transcripts.

5. **`ClosedTask.result` is lost at close** (see types.ts item). The worker's summary — which is often the most compact statement of what changed — is discarded. Preserving it in `ClosedTask` would give a free lightweight memory layer at no additional cost.

### Recommended path to global memory

A minimal v1 would require three additions:

1. `listAllSessionDirs(): Promise<{ cwd: string; sessionDir: string }[]>` — walks `~/.pi/agent/sessions/`, decodes slugs, returns all known cwds.
2. `extractSessionSummary(jsonlPath: string): Promise<SessionSummary>` — structured extraction: repo path, start time, tool calls made, file paths touched, final assistant message (the decision summary).
3. A background indexer that runs `extractSessionSummary` on new sessions and appends to `~/.pi/agent/memory-index.jsonl`.

With that index, a "what have I done in this repo" or "have I seen this error before" tool becomes a grep over a single file rather than a full JSONL scan.
