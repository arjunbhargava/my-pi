# Agents Extension: Code Review

Files reviewed:
- `src/extensions/agents/agents.ts`
- `src/extensions/agents/commands.ts` (374 lines)
- `src/extensions/agents/launcher.ts` (334 lines)
- `src/extensions/agents/discovery.ts` (128 lines)
- `src/extensions/agents/env-propagation.ts`
- `src/extensions/agents/types.ts`
- `src/extensions/agents/agent-config.ts`
- `src/extensions/agents/archive.ts`
- `src/extensions/agents/team-agent/index.ts`
- `src/extensions/agents/team-agent/manifest.ts`
- `src/extensions/agents/team-agent/runtime.ts` (144 lines)
- `src/extensions/agents/team-agent/session.ts` (96 lines)
- `src/extensions/agents/team-agent/config.ts`
- `src/extensions/agents/team-agent/watch.ts`
- `src/extensions/agents/team-agent/board.mjs`
- `src/extensions/agents/team-agent/tools/dispatch.ts` (497 lines)
- `src/extensions/agents/team-agent/tools/review.ts` (569 lines)
- `src/extensions/agents/team-agent/tools/queue.ts` (302 lines)

---

## 1. Lifecycle Correctness

### Control-plane path

`agents.ts:32` checks `AGENT_CONFIG_ENV_VAR` at startup. If set, the process is a spawned team agent and delegates to `teamAgentExtension`. If unset, it registers user-facing commands and calls `rediscoverTeams` on `session_start`. The bifurcation is clean and the two paths share no state.

`launchTeam` (launcher.ts) follows this sequence:
1. Generate team ID + slug → derive tmux session name.
2. Write queue file (`createQueue` + `writeQueue`).
3. Create tmux session with `board` window, launch `board.mjs` via `sendKeys`.
4. For each permanent agent: write config JSON + launch shell script → `createWindow`.
5. On any `createWindow` failure: `killSession` rolls back the whole tmux session.

The rollback is partial: if `createWindow` for agent N fails, agents 0..N-1 have already been spawned but the tmux kill will end them. The queue file and agent config JSONs on disk are NOT cleaned up. On the next `session_start`, `rediscoverTeams` will find the queue file but `sessionExists` will return false, so the file lands in `stale` — harmless but accumulates on repeated failures. There is no cleanup path for stale queue files.

`stopTeam` (launcher.ts:327) is `killSession` only. Queue files, agent config JSONs, and launch scripts are left on disk. The design treats them as archive, which is consistent with `/team-logs`, but `/team-stop` offers no option to clean up.

### Agent startup

Each permanent agent receives its system prompt via `before_agent_start` (session.ts:43) rather than `--append-system-prompt`, because the CLI flag hangs in `-p` mode when an extension is loaded. This is correct.

Worker initial prompt is passed as a positional argument to `pi` (launcher.ts:172-174). This eliminates the `send-keys` timing race that previously existed.

### Worker lifecycle

`dispatch_task` (dispatch.ts:113-192):
1. Snapshot read (unlocked) to get `targetBranch`.
2. `createWorkspace` (git operations — outside lock, correctly).
3. `withQueueLock` → `dispatchTask` mutates queue.
4. If step 3 throws (e.g., task already dispatched by a race), `cleanupWorkerGit` is called in the catch block — the orphaned workspace is recovered.
5. `spawnAgentWindow` — if this fails after a successful queue mutation, the workspace is cleaned up but the task stays in `active` status assigned to a non-existent worker. The monitor's dead-worker detection will recover it on the next heartbeat (10s). Acceptable.

Workers complete via `complete_task` → `wait_for_verdict`. The wait loop handles `closed` (exit signal), `active` (revision feedback), and `queued` (rejection) transitions. The `"queued"` branch in `wait_for_verdict` returns text telling the worker to exit, but does not force an exit — relies on the worker model reading and acting on the message.

---

## 2. Tmux Process Management

### Dead worker detection

`isWorkerAlive` (runtime.ts) checks `listWindows` for the worker's window name — it confirms the tmux window exists, not that the `pi` process inside it is running. A crashed `pi` process that left an orphan tmux window (e.g., shell exit but `tmux kill-window` was never called) will appear alive to the monitor. The monitor would then see stale `window_activity` and eventually flag it as stalled after `STALL_THRESHOLD_MS` (5 minutes). Recoverable but delayed.

### Stall detection false-positive: the wait_for_verdict zombie

`STALL_THRESHOLD_MS = 5 * 60 * 1000` (dispatch.ts:47). Stall is detected via `getWorkerLastActivity`, which reads `#{window_activity}` — tmux's last time any output was written to the window pane.

A healthy worker sitting inside `wait_for_verdict` is blocked in `watchQueueUntil` with `WAIT_HEARTBEAT_MS = 30_000`. During those 30 seconds, the worker process writes nothing to the terminal. After 5 minutes of waiting for an evaluator, `window_activity` will be 5 minutes old and the monitor will classify the worker as stalled, kill its window, destroy its worktree, and requeue the task.

This is a real correctness bug. A task that takes the evaluator more than 5 minutes to review will be repeatedly requeued and re-executed. Manifestations in practice:
- A single slow evaluator review can trigger repeated re-dispatches of the same task.
- The evaluator's `wait_to_evaluate` will eventually see the task again (requeued and re-dispatched), surfacing the same review work twice.

The fix is to use a more reliable liveness signal — either `pane_dead` (tmux flag when the pane's process has exited), a process-level health file, or by simply not applying the stall threshold to workers whose task is in `review` status.

### `window_activity` on macOS vs Linux

`#{window_activity}` is updated on any pane output in the window, which includes tmux's own control messages on some configurations. Behaviour is consistent but worth noting that activity timestamps can be slightly ahead of actual process output (by a few ms).

---

## 3. Queue Locking

### Mechanism

`proper-lockfile` (runtime.ts:96-115) creates a `.team-<id>.json.lock/` sibling directory. Lock parameters: `retries: 10`, min/max backoff 50–500ms factor 1.5, `stale: 10_000` (10s stale reclamation). This is an advisory lock — all agents must go through `withQueueLock`; nothing enforces it externally.

### Correctness

All queue-mutating calls go through `withQueueLock`:
- `addTask` (queue.ts:103)
- `completeTask` (queue.ts:158)
- `dispatchTask` (dispatch.ts:140)
- `applyDeadWorkerRecovery` (dispatch.ts:473)
- `closeTask` (review.ts:467)
- `reviseTask` (review.ts:522)
- `rejectTask` (review.ts:555)
- `autoRejectTask` (review.ts:303)

`withQueueLock` re-reads the queue inside the lock from disk, passes the fresh copy to the callback, then writes the mutated copy back. Concurrent readers (e.g., `loadQueue` called for a snapshot) do not take the lock — they may see intermediate states between write cycles, which is acceptable because snapshots are only used for read-only decisions.

The atomic write in `writeQueue` (tmp file + rename) ensures no reader can see a partial write, even without the lock.

### Limitation

`proper-lockfile` requires the lock target file to exist before calling `lock()`. The queue file is written before any agent starts (launcher.ts:224-226), so this precondition is always satisfied in the normal flow.

If the queue file is deleted while agents are running (e.g., manual cleanup), all `withQueueLock` calls will throw with an ENOENT from `lockfile.lock`. The error propagates as a thrown exception inside tool handlers, which pi will catch and surface to the agent model as a tool error. Not catastrophic but not handled with a friendly message.

### No cross-process lock for non-`withQueueLock` reads

`withQueueLock` also calls `readQueue` inside the lock after acquiring it. However, a reader outside `withQueueLock` (e.g., `runtime.loadQueue()` for a snapshot) does not acquire the lock first. On NFS or network filesystems, this could yield a stale read. On local filesystems, the atomic rename makes this safe — you get either the old or the new file, never a partial write.

---

## 4. Module Size Violations

### dispatch.ts (497 lines)

Exceeds the 400-line AGENTS.md limit by 97 lines. Three distinct responsibilities are co-located:

**Extraction targets:**

`dead-worker.ts` (extract ~100 lines):
- `DeadWorker` interface
- `detectDeadWorkers`
- `cleanupDeadWorkers`
- `applyDeadWorkerRecovery`
- `reasonMessage`

These are pure dead-worker lifecycle helpers with no dependency on dispatch or monitor logic. They are already called from two places (`handleMonitor` and `handleCheckWorkers`).

`monitor.ts` (extract ~150 lines):
- `handleMonitor`
- `handleCheckWorkers`
- `signQueue`
- `statusCode`

Both handlers share the dead-worker helper import and the watch loop pattern. Extracting them leaves `dispatch.ts` with only `handleDispatch`, `findWorkerDefinition`, and the `registerDispatchTools` registration shell (~120 lines).

### review.ts (569 lines)

Exceeds the 400-line limit by 169 lines. Two distinct responsibilities:

**Extraction targets:**

`rebase-triage.ts` (extract ~230 lines):
- `handleWait`
- `autoRejectTask`
- `handleResolveConflicts`
- `StructuralConflictInfo` interface
- `formatStructuralConflicts`

These are the rebase + conflict triage path. They form a coherent unit: wait for review tasks, rebase them, classify conflicts, surface to evaluator or auto-reject.

`review-actions.ts` (extract ~150 lines):
- `handleClose`
- `buildCloseCommitMessage`
- `handleRevise`
- `handleReject`

These are the post-review mutation operations — what the evaluator does after reading the task. They have no dependency on the wait/rebase path.

`review.ts` retains only `registerReviewTools` (~50 lines of registration).

### commands.ts (374 lines)

At 374 lines, not yet over the limit but approaching it. The `formatArchiveListing` formatter and `/team-logs` handler together are ~80 lines that could move to `archive.ts` or a `log-command.ts` when the file next grows.

---

## 5. Instance Discoverability

### What the current system provides

**On `session_start`** (agents.ts:68-91):
- Computes `baseDir = <repoRoot>-worktrees`
- Calls `rediscoverTeams(ctx, baseDir, repoRoot, repoRoot)`
- `rediscoverTeams` scans for `.team-<id>.json` files, checks each queue's `tmuxSession` against `tmux list-sessions`, rebuilds window list for live sessions
- Notifies user of reattached teams; sets status bar to `[teams: <goals>]`

**`/team-status`**: reads queue for each team in `activeTeams` + lists tmux windows. Shows task counts, window names.

**`/team-attach`**: prints the `tmux attach` command for a selected active team.

**`/team-logs`**: walks `<repoRoot>-worktrees/.team-configs/` for archived config JSONs and pairs them with `~/.pi/agent/sessions/` archives.

**`board.mjs`**: live TUI per team session showing queue state, rendered in the `board` tmux window.

### What is missing

**No cross-repo view.** `rediscoverTeams` is called with `baseDir = <currentRepo>-worktrees`. If the user opens pi in repo A and has a running team in repo B, that team is invisible. There is no scan of other repos.

**No global registry.** Nothing writes a global `~/.pi/agent/running-teams.json` on team launch. There is no persistent record of where teams are across repos. After a machine restart or tmux session detach, the only recovery path is opening pi in the exact repo the team was launched from.

**No `/pi-status` or fleet command.** The closest is `tmux list-sessions | grep pi-team-`, which gives session names but not goals, repos, task counts, or health. The user must open a specific repo's pi, trigger `session_start` rediscovery, then run `/team-status` to see anything useful.

**Standalone pi instances are invisible.** A non-team pi process running in a tmux window (e.g., a separate pi session in repo C) has no representation in the agents extension. There is no mechanism to list or inspect it.

**Status bar is per-repo.** The `ctx.ui.setStatus` call (agents.ts:85) only updates the current pi instance's status bar. Other repos' pi instances have no visibility into each other.

**`rediscoverTeams` loses definition metadata.** On rediscovery, `agentsFromWindows` (discovery.ts:112-124) infers agent role from window name prefix (`worker-` = worker, everything else = permanent). The original `definitionName` and `capabilities` from the config JSON are not re-read. The config JSONs are available in `.team-configs/`; they are read by `archive.ts` but not by `discovery.ts`.

### What a dashboard would need

For a "where are all my agents?" view, the following information sources would be required:

**Global team registry** — written on every `launchTeam`, updated (removed) on every `stopTeam`:
- Path: `~/.pi/agent/running-teams.json`
- Fields per entry: `{ teamId, goal, tmuxSession, repoRoot, queuePath, createdAt }`
- This gives repo-agnostic enumeration without scanning tmux

**Live queue read** — for each registered team, `readQueue(queuePath)` yields task counts by status

**tmux session check** — `sessionExists` + `listWindows` confirms liveness and window inventory

**Process check (optional)** — `pane_current_command` or checking if the window's PID is still alive would distinguish "window open but pi crashed" from "pi running normally"

**Dashboard rendering** — a fleet variant of `board.mjs` that reads `~/.pi/agent/running-teams.json`, checks liveness for each team, and renders a multi-team summary. Could be launched via a `/pi-status` command or a standalone `node fleet.mjs` script.

**Information per team row:**
- Goal (truncated)
- Repo root
- tmux session name
- Task counts: queued / active / review / closed
- Window count (permanent agents + active workers)
- Age (time since `createdAt`)
- Last queue update (from `updatedAt`)

---

## 6. Additional Findings

### Evaluator gets `add_task`

`manifest.ts:81`: the evaluator (capability `close`) receives `addTask: true`. The docstring comment at line 50-52 says "evaluator → read_queue, review bundle" but `addTask` is not mentioned. This appears intentional (the evaluator may need to spawn follow-up tasks after reviewing), but the discrepancy between comment and code should be resolved.

### `handleWait` unbounded recursion

`review.ts:278`: when all tasks in a review batch are auto-rejected and no structural conflicts remain, `handleWait` recurses via `return await handleWait(runtime, signal)`. If tasks repeatedly fail rebase on every submission (e.g., a perpetually conflicting branch), the call stack grows without bound. One iteration adds one stack frame because the recursion is not in a loop.

This should be rewritten as an iterative `while` loop (which `handleMonitor` already does correctly — see dispatch.ts:217).

### `PATH` not propagated to spawned agents

`env-propagation.ts` propagates API keys and provider tokens but not `PATH`. The launch script invokes `pi` by name without an absolute path. If `pi` is installed in a user-local location (e.g., `~/.npm/bin`, `/home/user/.nvm/...`) that is not in tmux's default `PATH`, the agent process will fail with `command not found`. On macOS with tmux launched from a terminal, `PATH` typically inherits correctly. On Linux or when tmux is started from a systemd service or login, it may not. Adding `PATH` to `PROVIDER_PREFIXES` or as an explicit propagation would harden this.

### Session filter heuristic in archive.ts

`archive.ts:145-151`: permanent agents (orchestrator, evaluator) run with `cwd = repoRoot`, which they share with every other pi invocation in that repo. Sessions are filtered to those starting on or after `queue.createdAt`. This heuristic is acknowledged in a comment. If the user starts a team and was already mid-session in the same repo, that ongoing session would be excluded from the team's archive, and a session that started slightly before `createdAt` due to clock skew would also be excluded. Not a correctness problem for normal use.

### `discoverAgentsFromDirs` override semantics

`agent-config.ts`: later directories override earlier ones by agent name (`byName.set(agent.name, agent)`). The scan order is `[packageAgentsDir, projectAgentsDir]`, so project-local agents override package defaults. This is the intended behavior (documented in the function JSDoc) and correctly implemented.

### `sq()` is correct but not exported

`launcher.ts:70-72`: the `sq()` single-quote escaping function is private to `launcher.ts`. The `writeAgentLaunchScript` function uses it internally and is exported. No callers outside `launcher.ts` need raw shell quoting, so this is fine.

### `board.mjs` is plain JS, not TypeScript

`board.mjs` is deliberately plain Node ESM (no transpilation, no extra deps). The comment explains this. It is excluded from TypeScript compilation. This is a conscious trade-off: the board needs to run directly without a build step, so it cannot be `.ts`. The trade-off is accepted and documented.

### `config.ts` supports inline JSON for backward compatibility

`config.ts:20-21`: if `PI_TEAM_AGENT_CONFIG` does not end in `.json`, it is parsed as an inline JSON string. The comment says "legacy tests may still set the env var to an inline JSON string." This dead path should be removed once tests are updated — the file-path form is superior and the inline form is a shell-escaping risk for any new user.
