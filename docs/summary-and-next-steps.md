# Summary and Next Steps

Synthesized from seven reports produced during team session `c676782a`:
- `docs/review-lib-layer.md`
- `docs/review-worktree-extension.md`
- `docs/review-agents-extension.md`
- `docs/review-lsp-extension.md`
- `docs/review-websearch-extension.md`
- `docs/research-agentic-ecosystem.md`
- `docs/feature-proposals.md`

---

## Cross-Report Assessment

**Consistency:** All seven reports are internally consistent and do not contradict each other. Code references in feature proposals correctly reflect the reviewed source.

**One significant gap in `feature-proposals.md`:** All six Priority 1 proposals are new features. None address the critical and high-severity bugs identified in the code reviews. The bugs in items 1–4 below predate any new feature work and break existing functionality that the system depends on. They should ship before any new feature lands.

**Report quality:** All five code reviews are specific (file:line citations throughout), internally consistent, and actionable. The ecosystem research is thorough and applicability notes are grounded. The feature proposals build correctly on the review findings for new work.

---

## Top 10 Actions

Ordered by: blocking correctness bugs first, then high-leverage features by impact-to-effort ratio.

---

### 1. Fix `conflict.ts` rewrite-ratio formula

**Type:** Bug fix (CRITICAL)
**Source:** `review-lib-layer.md` → "Critical" ranking, `docs/known-issues.md`
**Files:** `src/lib/conflict.ts:165–174`

**Issue:** The denominator for the rewrite-ratio calculation is `originalSize + numstat.added = numstat.removed + numstat.added = totalChanged`, making the ratio `totalChanged / totalChanged = 1.0` whenever any lines are removed. Every modified file with at least one deleted line is classified as "structurally rewritten," regardless of actual change magnitude. This is the conflict classification logic that `docs/known-issues.md` was specifically written to fix — the fix landed broken.

**Fix:** Change the denominator to `originalSize` alone:
```typescript
// conflict.ts:172
const ratio = originalSize > 0 ? totalChanged / originalSize : 0;
```
Then add `tests/conflict.test.ts` — this module has zero test coverage (confirmed: not in `scripts/test-unit.sh`). Use real git repos to test the ratio boundaries, as the existing `tests/diff-name-status.test.ts` does.

---

### 2. Fix stall detection false-positive killing workers in review

**Type:** Bug fix (CRITICAL)
**Source:** `review-agents-extension.md` §2 "Stall detection false-positive"
**Files:** `src/extensions/agents/team-agent/tools/dispatch.ts:47` (`STALL_THRESHOLD_MS`)

**Issue:** `STALL_THRESHOLD_MS = 5 * 60 * 1000`. A healthy worker inside `wait_for_verdict` writes nothing to its tmux pane for up to 30 seconds per heartbeat cycle. After 5 minutes of evaluator review time, `window_activity` triggers stall detection; the monitor kills the worker window, destroys the worktree, and requeues the task. Any evaluation taking more than 5 minutes triggers an infinite requeue-and-reexecute loop.

**Fix:** In `dispatch.ts:handleCheckWorkers` (or wherever stall detection reads task status), skip the stall check for any active task currently in `review` status. A task in review is waiting on the evaluator, not the worker — tmux inactivity is expected and correct. The one-line guard: `if (task.status === "review") continue;` before the activity threshold check.

---

### 3. Fix LSP silent empty-success + bootstrap timestamp gap

**Type:** Bug fix (HIGH) — three surgical changes
**Source:** `review-lsp-extension.md` Root Causes 1, 2, 3; `feature-proposals.md` §B2
**Files:** `src/extensions/lsp/resolver.ts:57–76, 246–260`; `src/extensions/lsp/bootstrap.ts:71–82`

**Issue:** Three compounding bugs make every cold-start LSP call return `{ ok: true, value: [] }`, indistinguishable from "symbol doesn't exist." The model concludes LSP doesn't know the symbol and falls back to grep permanently for that session.

**Fix 1 — `resolver.ts`:** When `clients.length === 0`, return `{ ok: false, error: "No language server active. Supported: TypeScript/JavaScript, Python, C/C++, Rust. Ensure server binary is installed and project marker file exists." }` instead of looping over an empty array.

**Fix 2 — `bootstrap.ts:71–82`:** Move `this.bootstrapped.add(languageId)` and `this.bootstrapTimestamps.set(languageId, Date.now())` to before the `if (bootstrapFile)` block. The server was spawned regardless of whether a bootstrap file was found; the 19s retry window should fire either way.

**Fix 3 — `resolver.ts:258`:** Replace `return [result.value]` with `spawnedClients.push(result.value)` inside the multi-language detection loop; return `spawnedClients` after the loop. Currently only the first detected language spawns on the first tool call — Python/Rust queries return empty until a second call.

---

### 4. Add `@types/node` to `devDependencies` and `tsconfig.json`

**Type:** Build fix (HIGH)
**Source:** `review-lib-layer.md` → "Critical" ranking
**Files:** `package.json`, `tsconfig.json`

**Issue:** `@types/node` is missing. `tsc --noEmit` reports 7+ errors in `src/lib/` alone (`task-queue.ts`: 3 errors, `session-archive.ts`: 3 errors, `NodeJS` namespace: 1 error) and additional errors in extensions. The codebase cannot be type-checked clean. The specific trigger is `err as NodeJS.ErrnoException` at `src/lib/task-queue.ts:60`.

**Fix:** `npm install --save-dev @types/node` and add `"types": ["node"]` to `tsconfig.json` `compilerOptions`. Verify with `npx tsc --noEmit` producing zero errors before closing.

---

### 5. `session-memory.md` — per-worktree context file

**Type:** New feature (HIGH leverage, low effort)
**Source:** `feature-proposals.md` §C1; `research-agentic-ecosystem.md` §4 (Cline Memory Bank, Claude Code CLAUDE.md pattern)
**Files:** `src/extensions/worktree/checkpoint.ts`, `src/extensions/worktree/worktree.ts`

**Issue:** Each new pi session starts without memory of what prior sessions on the same task built or decided. The lib review documents five gaps in `session-archive.ts` that prevent cross-session memory. The worktree extension already has the two hooks needed: `agent_end` (checkpoint time) and `before_agent_start`.

**Fix:** In `checkpoint.ts`, after the checkpoint commit lands, write/update `.pi/session-memory.md` in the task worktree with: the task description, a list of files modified, and a slot for the agent's decision summary. In `worktree.ts:before_agent_start`, if `.pi/session-memory.md` exists in the active task's worktree, inject it as a steer message. Workers and `agents/roles/*.md` get an instruction to append a 2–3 sentence decision summary to this file at the end of each turn. Scope: S (< 1 day). No new dependencies.

---

### 6. `worktree_diff` tool + structured patch preview at accept time

**Type:** New features (HIGH, addresses primary stated pain point)
**Source:** `feature-proposals.md` §A1, §A2; `review-worktree-extension.md` §6
**Files:** `src/lib/git.ts`, `src/extensions/worktree/tools.ts`, `src/extensions/worktree/accept-reject.ts`, `src/extensions/worktree/commands.ts`

**Issue:** No line-level content is ever shown through the extension UI. Pre-accept preview is a `--stat` toast. Checkpoint diffs are invisible in real time. The user cannot review what the agent actually wrote without a separate terminal window.

**Fix (A1):** Add a `worktree_diff` tool in `tools.ts`. Parameters: `{ from?, to?, stat? }` — defaults to `main..HEAD`. Calls a new `showPatch(from, to, ctx)` wrapper (~10 lines) in `git.ts`. Prompt guideline: "call `worktree_diff` after agent changes to verify modifications before accepting."

**Fix (A2):** Extract a `buildAcceptPreview(task, ctx, gitCtx)` helper into `accept-reject.ts` returning `{ stat, patch }`. Both `commands.ts:wt-accept` and `tools.ts:worktree_accept` call this helper (currently duplicated — noted as a duplication bug in the worktree review). The `patch` is written to a temp file and displayed before the confirm prompt. The auto-accept path appends the stat summary to the squash commit message body.

Combined scope: M (1–2 days). No new dependencies.

---

### 7. `lsp_status` tool + session-start steer message

**Type:** New feature (MEDIUM leverage, low effort)
**Source:** `feature-proposals.md` §B1; `review-lsp-extension.md` Barrier 3
**Files:** `src/extensions/lsp/tools.ts`, `src/extensions/lsp/lsp.ts`, `src/extensions/lsp/bootstrap.ts`

**Issue:** The model has no signal to know whether language servers are running, indexing, or not yet started. Without this, it either assumes ready (empty results during indexing → gives up) or assumes not ready (skips LSP → falls back to grep). This is Adoption Barrier 3 in the LSP review.

**Fix:** Add a `lsp_status` tool that calls `registry.getActiveLanguages()` and a new `bootstrap.getBootstrapState(lang)` method, returning: `"Active: typescript (indexed 42s ago)"` or `"No servers active. Supported: typescript, python, cpp, rust."`. In `lsp.ts:session_start`, inject a steer message (with `display: false`) listing available languages after registry/resolver initialization. Update `promptGuidelines` for all four LSP tools to add: "If results are empty on the first call, the server may still be indexing — call `lsp_status` to check, then retry." Scope: S (< 1 day).

---

### 8. Outbound webhook notification system

**Type:** New feature (MEDIUM leverage, low effort, ships standalone)
**Source:** `feature-proposals.md` §E2; `research-agentic-ecosystem.md` §6
**Files:** `src/lib/notifier.ts` (new), `src/extensions/agents/team-agent/tools/review.ts`, `src/extensions/agents/team-agent/tools/dispatch.ts`

**Issue:** The user has no way to know a task completed, failed, or requires attention without actively polling the board or opening pi. Async agent work loses its value if the human has to babysit.

**Fix:** Add `src/lib/notifier.ts` (~60 lines). Uses Node's built-in `fetch` — no new packages. Reads `PI_NOTIFY_WEBHOOK` env var; if absent, all calls are no-ops. Call sites: `review.ts:handleClose` (task complete), `review.ts:handleWait` on structural conflict surface (task blocked), `dispatch.ts:autoRejectTask` (task rejected). For Slack: user creates an Incoming Webhook in 2 minutes (no Slack app review), pastes URL into `PI_NOTIFY_WEBHOOK`. Message format is Slack-compatible `{ "text": "..." }`. Scope: S (< 1 day). Can ship before any Slack inbound work (E1).

---

### 9. Global pi registry + fleet dashboard (`/pi-fleet`)

**Type:** New feature (MEDIUM leverage, medium effort)
**Source:** `feature-proposals.md` §D1; `review-agents-extension.md` §5
**Files:** `src/extensions/agents/launcher.ts`, `src/lib/team-registry.ts` (new), `src/extensions/agents/scripts/fleet.mjs` (new), `src/extensions/agents/commands.ts`

**Issue:** `rediscoverTeams` is scoped to `<currentRepo>-worktrees`. A running team in repo B is invisible from repo A. After tmux detach or machine restart, teams are unrecoverable without opening the exact repo they were launched from. Standalone pi instances have no representation anywhere.

**Fix:** Write `~/.pi/agent/running-teams.json` on `launchTeam` (appended entry: `{ teamId, goal, tmuxSession, repoRoot, queuePath, createdAt }`); remove on `stopTeam`. Add `src/lib/team-registry.ts` with `readRegistry()`, `addTeam()`, `removeTeam()`, `listLiveTeams()` (cross-checks entries against `sessionExists`). `fleet.mjs` reads the registry every 5 seconds, queries each queue file for task counts, renders a table: `TEAM | GOAL | REPO | QUEUED | ACTIVE | REVIEW | CLOSED | AGE`. A `/pi-fleet` command in `commands.ts` opens or attaches to the fleet window. Uses the write-to-temp-then-rename pattern from `shared-state.ts` for atomicity. No new npm packages. Scope: M (2–3 days).

---

### 10. Add `conflict.ts` and LSP tests to `scripts/test-unit.sh`

**Type:** Test coverage (MEDIUM — prevents regressions in critical code)
**Source:** `review-lib-layer.md` §conflict.ts; `review-lsp-extension.md` Barrier 5
**Files:** `scripts/test-unit.sh`, `tests/conflict.test.ts` (new), existing `tests/lsp-*.test.ts`

**Issue:** `conflict.ts` has zero test coverage — the ratio formula bug (item 1 above) went undetected because there are no tests. Five LSP test files exist but none appear in `test-unit.sh`: `lsp-diagnostics.test.ts`, `lsp-client.test.ts`, `lsp-transport.test.ts`, `lsp-resolver.test.ts`, `lsp-registry.test.ts`. Of these, four have no real-server dependency and can run unconditionally (confirmed in LSP review). `websearch-browse.test.ts` also exists but is absent from the script.

**Fix:** Create `tests/conflict.test.ts` with scenarios exercising the ratio formula across: pure additions, single-line removal, majority rewrite, complete file replacement. Add the four safe LSP tests and `websearch-browse.test.ts` to `test-unit.sh`. Scope: S per test file once the formula is fixed.

---

## Deferred (Priority 2–3 features from `feature-proposals.md`)

These are sound proposals with no blocking issues. Defer until items 1–10 are done:

| Feature | Proposal | Scope | Note |
|---|---|---|---|
| Global session index + `/pi-memory` | C2 | L | Depends on C1 (item 5) being in place first |
| Preserved task results in `ClosedTask` + `/team-history` | C3 | S | One-line type change; enables C2 |
| `/pi-status` fleet command | D2 | S | Depends on D1 registry (item 9) |
| Eager LSP server spawn at worktree creation | B3 | M | Useful after items 3 and 7 land |
| Slack inbound queue bridge | E1 | M | Depends on E2 (item 8) already running |
| External diff tool passthrough (delta/difftastic) | A3 | S | Polish; depends on A1/A2 (item 6) |
| tmux status-right integration | D3 | S | Depends on D1 (item 9) |
| SSH + Tailscale mobile setup command | E3 | S | No blocking dep; low priority |

---

## Areas Reviewed and Found Structurally Sound

(No action items, but noted for completeness):

- `src/lib/commit-message.ts` — clean, single-responsibility, 12 tests covering all exported functions
- `src/lib/session-archive.ts` — solid foundation for future memory features; 7 tests; intentional design choices documented
- `src/extensions/agents/team-agent/queue.ts` — locking, atomic writes, and RMW pattern all correct
- `src/extensions/websearch/` — Browserbase integration structurally sound; error handling consistent throughout; one silent failure (`waitForLoadState` `.catch(() => {})` in `browse.ts:121`) worth logging but not critical
- `src/extensions/agents/env-propagation.ts` — correct; `PATH` propagation gap noted (agents review) but low risk on standard installs
- Tmux IPC writes — atomic (write-to-temp-then-rename throughout)
- Module boundaries — no `exec("git", ...)` calls outside `git.ts`; no `@earendil-works/pi-coding-agent` imports outside extension entry points
