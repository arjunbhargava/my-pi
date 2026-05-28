# Worktree Extension — Code Review

Covers all 10 files in `src/extensions/worktree/` plus the supporting `src/lib/` modules they depend on.
Reviewed: `worktree.ts`, `manager.ts`, `checkpoint.ts`, `tools.ts`, `commands.ts`, `accept-reject.ts`, `shared-state.ts`, `types.ts`, `extension-state.ts`, `pull-request.ts`

---

## 1. Event-Hook Architecture

### Chain: session_start → before_agent_start → agent_end → tool_call

**session_start** (`worktree.ts:130–156`):
- Calls `getRepositoryRoot`, `restoreState`, `mergeFromSharedState`, `discoverTasksFromGit` in sequence with proper awaits.
- If `getRepositoryRoot` fails, `repoRoot = null` and subsequent hooks check for null — cleanly safe.
- `persistState()` is declared `void` and calls `syncToSharedState()` without awaiting its result. If `session_start` returns before the background `syncToSharedState` resolves, any failures in the async file write are silently swallowed. Since this is initialization, the failure window is small but real.

**before_agent_start** (`worktree.ts:158–178`):
- Captures `event.prompt` into `currentPrompt`. No async operations. Safe.
- Only returns a message when there is an active task — correct.

**agent_end** (`worktree.ts:180–210`):
- Sequential: checkpoint first, then auto-accept.
- Checkpoint is wrapped in a bare `try/catch` that discards the error with no user notification (`// Checkpoint failure must not break the session`). A failed checkpoint means the user's agent turn is not recorded in git, but they receive no signal this happened.
- The auto-accept path runs unconditionally if `autoAccept === true`, even if the checkpoint silently failed.

**tool_call** (`worktree.ts:212–234`):
- Mutates `event.input` directly in place. The function returns `void` — the mutation takes effect before the hook returns.
- Covers `bash`, `read`, `write`, `edit`. LSP tools (`lsp_definition`, `lsp_references`, etc.) and `web_*` are not intercepted — by design for LSP, correct for web.
- LSP tools operate on the main worktree's language server. An agent writing to the task worktree via `edit` but reading types via `lsp_hover` will see the main branch's type signatures, not the task branch's. This is a semantic consistency gap, not a correctness bug in this file.

**No race conditions** in the normal path because JavaScript's event loop is single-threaded and pi dispatches events sequentially. The only async interleaving risk is when two calls to `refreshFromSharedState()` overlap — see Section 2.

---

## 2. State Management

### In-memory state

The single `state` object is shared across all event handlers via closure (and via `ExtensionState.state` getter). In-memory mutations are safe because JS is single-threaded; no two event handlers run simultaneously within a single pi session.

`session_start` reassigns `state` via `state = restoreState(...)` (`worktree.ts:138`). `ExtensionState` exposes `state` through a getter (`get state() { return state; }`), so all downstream code sees the new reference. This is correct.

### Concurrent refresh risk

Both `mergeFromSharedState()` and `discoverTasksFromGit()` mutate `state.tasks` in place, using a snapshot of `knownPaths` taken at the start of the call. If two tools call `refreshFromSharedState()` without awaiting the first to finish:

1. Both capture `knownPaths` at the same moment.
2. Both see the same "unknown" path.
3. Both add the same worktree to `state.tasks`.
4. Result: duplicate `TaskState` entries with different IDs.

In practice this requires two tool calls to be pending simultaneously, which is unlikely but not impossible if the agent issues two tools in quick succession before the first `refreshFromSharedState` resolves.

`discoverTasksFromGit` (`manager.ts:163–201`) generates a brand-new ID for every discovered worktree via `generateTaskId()`. If the same physical worktree is discovered twice (e.g., once by `mergeFromSharedState` restoring its original ID from the file, and once by `discoverTasksFromGit` assigning a new ID), the path-based deduplication prevents the second — but only if the first call's mutations are visible before the second call reads `knownPaths`. Since both check `knownPaths` against `state.tasks.values()` at call time, concurrent calls are not protected.

### Ghost tasks

If a worktree is manually deleted (user runs `git worktree remove` without going through the harness), its `TaskState` persists in the shared file. `mergeFromSharedState` will import it into the in-memory state on the next `refreshFromSharedState`. `discoverTasksFromGit` will not find the physical path, so no deduplication fires. `syncToSharedState` will then write the ghost task back to the shared file. Ghost tasks accumulate until a manual `/wt-reject` clears them.

---

## 3. Path Redirection in tool_call

**bash** (`worktree.ts:220–223`): Prepends `cd ${shellQuote(wtp)} && `. This sets the initial working directory for all relative operations within the command. Shell-safe quoting via `shellQuote` handles paths with spaces and apostrophes. Absolute paths inside the bash command are not redirected — intentional and correct for cases like `cat /etc/hosts`, but means an agent that hard-codes a path like `/home/user/project/src/foo.ts` will bypass the worktree redirect.

**Tilde handling** (`worktree.ts:44–47`): `resolveToWorktree` passes through paths where `filePath.startsWith("~")`. This is correct for `~/file` (shell will expand it), but Node.js file operations (`read`, `write`, `edit`) do NOT expand `~`. If an agent passes `~/foo` to the `read` tool, the path will be read literally as a `~`-prefixed relative path from the current working directory, almost certainly producing a "file not found" error. This is an edge case since well-behaved tools emit absolute paths, but it is a gap.

**Symlinks**: Not normalized. If `worktreePath` contains a symlink component, `path.join(worktreePath, relativePath)` will not resolve it. This is fine for most use cases but could cause tool calls to reference different physical locations than git operates on.

**write / edit**: Both use `event.input as Record<string, unknown>` with an unchecked `event.input.path as string`. If either tool lacks a `path` field in the actual call, the cast will produce `undefined` and `resolveToWorktree` will receive `undefined`, likely throwing. The null check `event.input?.path` guards the branch entry, but the cast inside has no further guard.

**Missing interception**: `lsp_workspace_symbols`, `lsp_diagnostics` — these take a `path` parameter for `lsp_diagnostics`. If the agent passes a path to `lsp_diagnostics` referring to a file in the task worktree, the path won't be rewritten and LSP will report diagnostics for the main tree copy.

---

## 4. Auto-Accept Flow

**Normal path** (`worktree.ts:196–209`):
1. Checkpoint (try/catch, errors silently dropped).
2. `acceptTask` → `getMainBranch` → `diffNameStatus` → `squashMergeWorkspace` → `destroyWorkspace`.
3. On `result.ok`: update status, clear `activeTaskId`, remove from shared state, persist.
4. On `!result.ok`: notify with error, no state mutation. Task stays active. User can retry. Correct.

**Risk: checkpoint swallowed before accept**: If the checkpoint try/catch swallows an error, the agent's turn is uncommitted. `squashMergeWorkspace` then merges the task branch into main — but the task branch does not include the latest agent changes. The merge proceeds on stale content with no warning.

**Risk: merge lands, teardown fails** (`accept-reject.ts:57–60`): `destroyWorkspace` is called as best-effort — its result is not propagated. If it fails:
- The worktree directory persists at `<repo>-worktrees/<slug>/`.
- The task branch is not deleted (`deleteBranch` is called inside `destroyWorkspace`).
- The merge commit on `main` is already present.
- `removeTaskFromSharedState` IS still called, so the shared state is cleaned.
- On the next session, `discoverTasksFromGit` will find the orphaned worktree and re-import it as a new task with no checkpoint history.

**Risk: base branch dirty check** (`workspace.ts:108–121`): `ensureMergeReady` checks that `main` is the current branch and has no uncommitted changes. If these fail, the merge is aborted and `result.error` is returned. This is correct. However, it assumes the main worktree's `cwd` is set to the root of a clean `main` checkout — if the user has `main` dirty at the moment `agent_end` fires, every auto-accept will fail until they manually clean up.

**Auto-accept toggle** (`worktree.ts:237–245`): `autoAccept` is a plain boolean in closure, not persisted to the pi session state. After a session restart, `autoAccept` resets to `false`. The status bar will reflect this on `session_start`, so the user will see it changed — but if they expected auto-accept to persist across restarts, they will be surprised.

**"no-op" SHA in notification**: When `squashMergeWorkspace` returns `{ kind: "noop" }`, `acceptTask` returns `"no-op"` as the value string. The notification reads `Auto-accepted: <desc> → no-op`. Not a bug, but could confuse: it looks like a short SHA.

---

## 5. Shared-State IPC

**Atomic writes** (`shared-state.ts:77–96`): Uses write-to-temp-then-rename pattern. The temp file is in the same directory as the target (`<repo>-worktrees/`), ensuring both are on the same filesystem. POSIX `rename(2)` is atomic. Readers will never see a partial write. Correct.

**Read-modify-write races**: `updateTaskInSharedState`, `removeTaskFromSharedState`, and `setActiveTaskInSharedState` all follow the same pattern: read full file → mutate → write back. Two pi instances doing this concurrently will race — last write wins. This means:
- If Session A updates Task 1 and Session B updates Task 2 simultaneously, one update will be lost.
- The `activeTasks` entry for one session could be overwritten by the other.
- Given that `syncToSharedState` calls `updateTaskInSharedState` per task in a sequential `for...of` loop, N tasks = N sequential RMW cycles. This amplifies the race window.

**Stale session entries**: The `activeTasks` map in `SharedState` (`shared-state.ts:42`) accumulates entries for every pi session ID (`pi-<timestamp-hex>`). Dead or closed sessions never clean up their entries. Over time, every repository accumulates entries indefinitely. There is no TTL, no cleanup on session close, and no tool to inspect or prune them.

**No schema validation**: The shared state file is parsed with `JSON.parse(raw) as SharedState` without any runtime validation. If the file is malformed (partial write that slipped through, manual edit, format change after a code update), the cast will succeed but subsequent property accesses may return `undefined` and fail silently or throw at unexpected locations.

**No versioning**: No `version` field in `SharedState`. If the format changes in a future commit, old files are silently parsed with the new schema, producing undefined behavior.

---

## 6. Diff Visibility

This section documents what the user can and cannot see about code changes at each point in the workflow.

### What exists today

| Moment | Mechanism | Content |
|--------|-----------|---------|
| Checkpoint created (end of agent turn) | No notification to user | — |
| `worktree_status` / `/wt` switch | Shows last 5 checkpoint SHAs, timestamps, first-line prompt descriptions | No file names, no diffs |
| Pre-accept in `worktree_accept` tool | `ctx.ui.notify(diff.value)` where `diff.value` is `git diff --stat main task/branch` output | File names + ±line counts only |
| Pre-accept in `/wt-accept` command | Same as above | File names + ±line counts only |
| Commit message in git log | Subject: `checkpoint: <prompt summary>` + `Changes:` bullet list of file names (from `diffStaged`) | File names, status (add/modify/delete), no content |
| After auto-accept | `ctx.ui.notify(...)` with "Auto-accepted: <desc> → <sha8>" | No diff content |

### What is missing

**No line-level content is ever shown through the extension UI.** The accept preview uses `git diff --stat` (`diffSummary` in `git.ts:287–295`), which emits only file names and insertion/deletion counts. The user cannot see what lines were added or removed without leaving the pi interface.

**Checkpoint diffs are invisible in real time.** After each agent interaction that modifies files, a checkpoint commit is created and the SHA is stored in `task.checkpoints[]`. The user is not notified that anything was committed. If they want to know what changed in the last agent turn, they must:
1. Know the SHA from `worktree_status` output.
2. Manually run `git show <sha>` in a separate terminal from inside the task worktree.

**No `worktree_diff` tool exists.** There is no tool that renders the current diff (or the diff between two specific checkpoints) as content the agent can report or the user can view in the pi chat pane. The `getTaskDiff` helper in `accept-reject.ts` exists but is only called in the accept flow and only shows `--stat` output.

**`worktree_status` omits file lists.** The status output lists checkpoint SHAs and prompt descriptions but no file names. The user cannot tell from the status what files were affected by each checkpoint.

**Notification channel is wrong for diffs.** The pre-accept diff is sent via `ctx.ui.notify()`, which renders as a transient toast/notification. For any non-trivial change set, this is unreadable: the stat output for a 10-file change is multi-line and likely to overflow or be dismissed before the user finishes reading it.

**No checkpoint-to-checkpoint diff.** Given two checkpoint SHAs, there is no tool to show what changed between them. The user can compute `git diff <sha1> <sha2>` manually but has no harness support.

**Auto-accept is blind.** When auto-accept is on, the user is notified of completion after the merge lands, with no opportunity to review changes before they are on `main`. The pre-merge diff shown in the manual accept flow is absent in the auto-accept path.

### Concrete scenario where this causes friction

A typical session:
1. User asks agent to "refactor the auth module."
2. Agent makes 8 file changes across 3 turns.
3. Three checkpoints are silently committed.
4. User runs `/wt-accept`. They see: `auth/index.ts | 14 +++---`, `auth/middleware.ts | 32 +++++----`, etc. — line counts but no content.
5. User has no way to judge the quality of the changes without opening a separate terminal.
6. If they confirm, the squash commit lands on `main` with a message that includes file names but no patch content.

The user's only recourse is to maintain a side terminal window running `git log -p` or `git diff`, which defeats the purpose of the harness providing workflow visibility.

---

## 7. Other Observations

### commands.ts vs. tools.ts duplication

`wt-accept` (command, `commands.ts:72–113`) and `worktree_accept` (tool, `tools.ts:159–234`) implement nearly identical accept flows: get diff, show via notify, confirm, prompt for message, call `acceptTask`, update state. They share no helper — changes to the accept UX must be made in both places.

### slugify uniqueness gap

`slugify` in `manager.ts:38–44` truncates descriptions to `MAX_SLUG_LENGTH = 48` characters. Two descriptions that differ only after character 48 produce the same branch name, which `branchExists` will catch and return an error. The error message says "Use a different description," which is accurate but obscure for a user who doesn't know about the 48-character limit.

### `worktree_accept` requires `ctx.hasUI`

`worktree_accept` and `worktree_reject` throw if `ctx?.hasUI` is false (`tools.ts:183–188`, `tools.ts:261–266`). This means an agent cannot programmatically accept a task — the tool is UI-only. This is a deliberate safeguard (confirmed in the docstring), but it means a headless agent session cannot call `worktree_accept` even if the user has pre-authorized the merge. The escape hatch is `/wt-accept` from a control-plane session, which is documented in the error message.

### `wt-pr` does not checkpoint first

`wt-pr` (`commands.ts:116–170`) pushes the current branch and opens a PR without checkpointing uncommitted changes first. If the agent's latest work is not yet committed, the PR will be opened against the last checkpoint, not the current state. `wt-update` does checkpoint first before merging (`commands.ts:211–221`); this pattern is absent from `wt-pr`.

### `discoverTasksFromGit` strips description fidelity

When a task is discovered from `git worktree list` output (e.g., from another session), its description is derived as `slug.replace(/-/g, " ")` (`manager.ts:186`). A task originally described as "add OAuth2 support" becomes branch `task/add-oauth2-support`, discovered as description "add oauth2 support" (lowercase, no camelCase, no special chars). The original casing and punctuation are permanently lost. Descriptions stored in the shared state file preserve the original, but tasks discovered from git alone lose it.

### `pull-request.ts` uses `branchName` parameter but also passes `-C ctx.cwd`

`createPullRequest` (`pull-request.ts:38–60`) calls `gh -C ctx.cwd pr create --head branchName`. The `ctx.cwd` should be the task worktree path. The `-C` flag sets the working directory for `gh`, which is correct. However, `pushBranch` is called before this in `wt-pr` with `es.gitCtx(activeTask.worktreePath)`, so the push context is also the task worktree. This is consistent. But if the user has a remote other than `origin`, `pushBranch` defaults to `origin`, and `gh pr create` will target `origin`. No way for the user to specify a different remote.
