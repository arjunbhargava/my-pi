# Feature Proposals

Built from: code reviews of all five extension areas, ecosystem research (task 251a72e4), and stated user pain points. 15 proposals across 5 categories.

---

## Category A — Diff Visibility

> Pain: "diffs aren't always the easiest to track in agentic coding"
>
> Root cause (from `review-worktree-extension.md`): no line-level content is ever shown through the extension UI. Pre-accept preview is a `--stat` toast. Checkpoint diffs are invisible in real time. No `worktree_diff` tool exists.

---

### A1. `worktree_diff` Tool

**Concept.** New tool the agent (or user) can call at any time to retrieve the full patch diff between two checkpoints, or between the current task branch and `main`. Returns the diff text as tool content the agent can read and reason about, rather than requiring a separate terminal window.

**Why it matters.** The `getTaskDiff` helper already exists in `accept-reject.ts` but is only called pre-accept and only shows `--stat` output. Without this tool, the user must mentally reconstruct changes from `worktree_status` checkpoint SHAs and manually run `git show` in a separate pane — defeating the purpose of the harness providing workflow visibility.

**Scope.** S (< 1 day)

**Architecture.**
- New tool `worktree_diff` registered in `src/extensions/worktree/tools.ts` alongside the existing worktree tools.
- Parameters: `{ from?: string, to?: string, stat?: boolean }`. `from`/`to` default to `main` and `HEAD` respectively; if `from`/`to` are checkpoint indices (0-based), resolve them from `task.checkpoints[i].sha`. `stat: true` returns `--stat` only (for compact summaries).
- Implementation calls two git functions already in `src/lib/git.ts`: `diffSummary` (stat) and a new `showPatch(from, to, ctx)` wrapper around `git diff <from> <to>`.
- `tools.ts` prompt guidelines should note: "call `worktree_diff` after asking the agent to make changes to verify what was modified before accepting."

**Dependencies.** None beyond existing `git.ts` utilities. New `showPatch` function is ~10 lines in `git.ts`.

**Priority.** 1

---

### A2. Full Patch Review Panel at Accept Time

**Concept.** Replace the `--stat`-only toast that fires before `/wt-accept` and `worktree_accept` with a properly paged or scrollable diff presentation. For any non-trivial changeset the agent renders a structured summary (files changed, brief per-file description) before the user confirms, and optionally opens the full patch in a pager.

**Why it matters.** The current flow shows something like `auth/index.ts | 14 +++---` in a transient notification — unreadable for multi-file changes and dismissed before the user finishes reading. The problem is identified in `review-worktree-extension.md §6` as the primary friction point at accept time. Aider solves this by making git the review surface; we need the equivalent inside the pi TUI.

**Scope.** M (1-2 days)

**Architecture.**
- `commands.ts:wt-accept` and `tools.ts:worktree_accept` both compute the diff; they share no helper, requiring changes in two places (noted as a duplication bug in the worktree review). Extract a `buildAcceptPreview(task, ctx, gitCtx)` helper into `accept-reject.ts` that:
  1. Calls `diffSummary` for the stat block (already done).
  2. Calls the new `showPatch` from A1 to get the full patch.
  3. Calls the agent (via a lightweight prompt) to produce a one-paragraph change summary in natural language.
  4. Returns `{ stat, patch, summary }`.
- Both `commands.ts` and `tools.ts` call this helper; `ctx.ui.notify` receives the `summary` and `stat`; the raw `patch` is written to a temp file and displayed via `ctx.ui.open` (or `PAGER` env variable) for the user to scroll.
- Auto-accept path (`agent_end`) should also call `buildAcceptPreview` and append the summary to the squash commit message body — the user gets a readable commit even when they weren't watching.

**Dependencies.** No new packages. The agent summarization step requires one tool call (or can be skipped with a feature flag).

**Priority.** 1

---

### A3. External Diff Tool Passthrough (delta / difftastic)

**Concept.** Detect `delta` or `difftastic` in `$PATH` and, when present, pipe the raw diff through the tool before presenting it. Adds syntax highlighting, side-by-side layout, and moved-line detection at zero cost to users who have these tools installed. Falls back to raw diff if neither is found.

**Why it matters.** The ecosystem research notes that diff tooling is a top usability pain point across all agentic coding tools. Users already installing `delta` or `difftastic` for their terminal workflow get that experience for free inside pi. Zero configuration for the common case.

**Scope.** S (< 1 day)

**Architecture.**
- Add `detectDiffRenderer(): "delta" | "difftastic" | "raw"` to a new `src/lib/diff-renderer.ts` (~30 lines). Uses `execFileSync("which", ...)` pattern already in `registry.ts`.
- The `buildAcceptPreview` helper from A2 calls `detectDiffRenderer()` and wraps the `showPatch` output accordingly.
- For `delta`: pipe through `delta --paging=never --width=120`.
- For `difftastic`: set `GIT_EXTERNAL_DIFF=difft` in the `git diff` subprocess env.
- User can override with `PI_DIFF_TOOL=raw` env var to disable.
- No changes to the core diff functions in `git.ts`.

**Dependencies.** `delta` (`dandavison/delta`) and `difftastic` (`wilfred/difftastic`) are optional external binaries — no npm packages required.

**Priority.** 3

---

## Category B — LSP Adoption

> Pain: "not getting consistent tool calls to use it from agents"
>
> Root cause (from `review-lsp-extension.md`): three compounding bugs — (1) empty success is indistinguishable from server-not-ready, (2) bootstrap timestamp not recorded when no file found disables the 19s retry window, (3) early `return` exits after spawning only the first detected language.

---

### B1. `lsp_status` Tool + Session-Start Steer Message

**Concept.** Add a `lsp_status` tool that returns current server state (language, whether indexed or still warming, elapsed time since spawn). Also inject a steer message at `session_start` listing available languages and whether servers are warm, so the model knows LSP is available and what to expect before making its first symbol query.

**Why it matters.** Adoption barrier 3 in the LSP review: "there is no way for the model to know whether a language server is running, indexing, or not yet started." Without this, the model either assumes LSP is ready (and gets empty results during indexing) or assumes it's not ready (and falls back to grep). Both paths degrade quality. The steer message is the lightest-weight intervention with the highest leverage.

**Scope.** S (< 1 day)

**Architecture.**
- New `lsp_status` tool registered in `src/extensions/lsp/tools.ts`. Calls `registry.getActiveLanguages()` + `bootstrap.getBootstrapState(lang)` (new method exposing `bootstrapped.has(lang)` and `bootstrapTimestamps.get(lang)`). Returns a structured status string: `"Active: typescript (indexed 42s ago), python (indexing, 8s elapsed)"` or `"No servers active. Supported: typescript, python, cpp, rust."`.
- Steer message injected in `lsp.ts:session_start` after registry/resolver initialization (lines 23–39). Uses `pi.sendMessage({ customType: "lsp_ready", content: "...", display: false }, { deliverAs: "steer" })`. Content includes supported languages and the note that servers spawn on first use.
- `promptGuidelines` for all four LSP tools gain: "If results are empty on the first call, the server may still be indexing — call `lsp_status` to check and retry in 5-10 seconds."

**Dependencies.** None. All state is already tracked in `registry.ts` and `bootstrap.ts`.

**Priority.** 1

---

### B2. Fix Silent Empty-Success and Bootstrap Timestamp Bug

**Concept.** Three one-to-five line fixes to the root causes identified in the LSP review: (1) return a structured error from `workspaceSymbols`/`resolveLocations`/`hover` when `getClients()` returns empty, instead of silently returning empty success; (2) record the bootstrap timestamp before the `if (bootstrapFile)` gate so the 19s retry window fires even when no source file is found; (3) remove the early `return [result.value]` in `getClients()` so all detected languages are spawned on the first call.

**Why it matters.** These three bugs are the primary driver of "model silently falls back to grep." They combine to make every cold-start and every non-standard project layout produce the same output as "this symbol doesn't exist." The fixes are surgical — no new abstractions, no new dependencies, no behavior change for users with warm servers.

**Scope.** S (< 1 day for all three)

**Architecture.**

Fix 1 — `resolver.ts`: when `clients.length === 0`, return `{ ok: false, error: "No language server active. Supported: TypeScript/JavaScript, Python, C/C++, Rust. Ensure the server binary is installed and a project marker file exists (tsconfig.json, pyproject.toml, Cargo.toml, compile_commands.json)." }`. The tool surface already handles `isError: true` correctly.

Fix 2 — `bootstrap.ts:71–82`: move `this.bootstrapped.add(languageId)` and `this.bootstrapTimestamps.set(languageId, Date.now())` to before the `if (bootstrapFile)` block. The server was still spawned regardless of whether a bootstrap file was found.

Fix 3 — `resolver.ts:246–260`: replace `return [result.value]` with `spawnedClients.push(result.value)` inside the loop; return `spawnedClients` after the loop. This ensures Python, Rust, etc. all spawn on the first tool call in a multi-language project.

**Dependencies.** None.

**Priority.** 1 (highest impact per line of code changed)

---

### B3. Eager LSP Server Spawn at Worktree Creation

**Concept.** When a new worktree is created (end of `createWorkspace` in `manager.ts`), proactively spawn the language server for the detected project type rather than waiting for the first LSP tool call. By the time the agent starts coding, the server has had several seconds to index.

**Why it matters.** Diagnostic injection (`lsp.ts:41–52`) requires a pre-existing active server; agents that only use `edit`/`write` never get diagnostics injected because they never trigger a server spawn. Pre-warming at worktree creation decouples server readiness from the agent's query behavior. This is particularly valuable for team-agent workers that immediately start editing files without first querying symbols.

**Scope.** M (1 day including testing)

**Architecture.**
- `src/extensions/worktree/manager.ts:createWorkspace` (at the end, after the worktree is on disk) calls a new `warmLspForPath(worktreePath)` function exported from the LSP extension entry point.
- `warmLspForPath` detects the project language from file markers in `worktreePath` (reusing `LspResolver.getClients(hintPath)` with a synthetic hint path) and calls `registry.getClientForLanguage(lang)` + `bootstrap.bootstrapServer(lang, client)` for each detected language.
- The call is fire-and-forget (the worktree creation does not block on server readiness). It returns immediately; the server indexes in the background.
- Cross-extension dependency: `worktree.ts` imports a function from `lsp/`. This requires the LSP extension to export `warmLspForPath` from its public interface, or the functionality moves to a shared lib helper. The cleanest boundary is exporting it from `src/lib/lsp-warmup.ts` — callable by any extension.

**Dependencies.** Requires the LSP registry/bootstrap instances to be accessible outside the LSP extension's session scope. If pi's extension architecture doesn't allow cross-extension instance sharing, the simpler fallback is to call `lsp_workspace_symbols("*")` with the worktree path as hint immediately after worktree creation.

**Priority.** 2

---

## Category C — Cross-Repo Memory

> Pain: "most of my tasks are related, even if they are across different repos"
>
> Root cause (from `review-lib-layer.md`): no persistent working memory; `ClosedTask.result` is discarded; `session-archive.ts` is a solid foundation but lacks global enumeration and structured extraction.

---

### C1. `session-memory.md` Per-Worktree Context File

**Concept.** After each checkpoint commit, write or update a `.pi/session-memory.md` file inside the task worktree. Contents: current task description, key decisions made this session, files changed and why, open questions. At `before_agent_start`, inject this file as a steer message so the agent resumes with full context even after a break or session restart.

**Why it matters.** This is the highest-leverage cross-session memory intervention with the smallest infrastructure footprint. Cline's Memory Bank, Claude Code's `CLAUDE.md`, and Windsurf's cascade memory all confirm the same pattern: a markdown file written by the agent and read at session start eliminates the "starting from zero" problem. Pi already has the checkpoint commit hook and the `before_agent_start` event — this is wiring them together.

**Scope.** S (< 1 day)

**Architecture.**
- `src/extensions/worktree/checkpoint.ts`: after the checkpoint commit lands, call `writeSessionMemory(task, worktreePath, gitCtx)`. This function:
  1. Reads the current `.pi/session-memory.md` in the worktree if it exists.
  2. Appends a new entry: `## Checkpoint [sha8] — [timestamp]` followed by the checkpoint's staged file list (already computed via `diffStaged`) and a slot for the agent's notes.
  3. Writes the file back to the worktree (not staged — the next checkpoint will pick it up).
- `src/extensions/worktree/worktree.ts:before_agent_start`: if `.pi/session-memory.md` exists in the active task's worktree, read and inject it as a steer message: `"[Context from previous work on this task]: ..."`.
- The agent is instructed (via `agents/roles/*.md` and `AGENTS.md`) to append a 2-3 sentence summary of decisions made and blockers encountered at the end of each turn, inside the memory file. This keeps the file human-readable and agent-writable.
- File is committed as part of the squash merge, giving the main branch a permanent record of the session's reasoning.

**Dependencies.** None. Uses existing `fs` writes in the worktree path and existing steer message mechanism.

**Priority.** 1

---

### C2. Global Session Index and `/pi-memory` Query

**Concept.** A background indexer runs on `session_start`, walks `~/.pi/agent/sessions/` across all repos, extracts structured summaries (repo, timestamp, tool calls, files touched, final message), and writes to `~/.pi/agent/memory-index.jsonl`. A `/pi-memory` command queries this index: "what did I work on in this repo last month?" or "have I seen this error before?"

**Why it matters.** The lib review identified five specific gaps in `session-archive.ts` that prevent it from serving as a global memory layer: no global enumeration, no structured extraction, no session-to-commit linkage, no index, and `ClosedTask.result` is discarded. This proposal addresses all five. The ecosystem research found Cline Memory Bank, Cursor's cursor-memory-bank, and Windsurf cascade memory all validate the demand for this pattern.

**Scope.** L (1+ week for the full version; M for the v1 index-only version)

**Architecture.**

**v1 — background indexer (M-scope, do first):**
- New `src/lib/session-indexer.ts`:
  - `listAllSessionDirs()`: walks `~/.pi/agent/sessions/`, decodes `--cwd-slug--` directory names (inverse of `sessionDirForCwd` — strips `--` separators, replaces `-` with `/`), returns `{ cwd, sessionDir }[]`.
  - `extractSessionSummary(jsonlPath)`: reads JSONL, extracts `{ repo, startMs, toolCalls: string[], filePaths: string[], finalMessage: string }`. Reuses `renderSessionToText` from `session-archive.ts` for the final message extraction.
  - `indexNewSessions(since: number)`: runs on sessions with mtime > `since`, appends entries to `~/.pi/agent/memory-index.jsonl`.
- `session_start` hook in a new `src/extensions/memory/memory.ts` extension: calls `indexNewSessions(lastIndexedAt)` in the background (non-blocking).

**v2 — query command (adds L-scope work):**
- `/pi-memory <query>` command in the memory extension: reads `~/.pi/agent/memory-index.jsonl`, filters by current repo or all repos, full-text searches over `toolCalls` and `filePaths`, returns the 5 most recent matching session summaries.
- Optional: embedding-based semantic search if `OPENAI_API_KEY` is available (`text-embedding-3-small` costs ~$0.00002 per session summary, negligible).

**Dependencies.**
- v1: no new packages; `session-archive.ts` already handles JSONL parsing.
- v2 semantic search: `openai` npm package (already likely present for the pi runtime).

**Priority.** 2

---

### C3. Preserved Task Results in Archive + `/team-history` Command

**Concept.** Preserve the worker's result summary in `ClosedTask` (currently discarded). Add a `/team-history` command that shows closed task summaries with result strings, timestamps, and which worker completed them — forming a lightweight "what was done" audit trail queryable inside pi.

**Why it matters.** The lib review identified `ClosedTask.result` loss as a gap that "blocks future audit/memory features." The result string is the most compact statement of what changed. Recovering it requires a one-line change in `types.ts` and a corresponding pass-through in `task-queue.ts:closeTask`. The `/team-history` command then makes this information accessible without opening a separate terminal or reading raw JSON files.

**Scope.** S (< 1 day)

**Architecture.**
- `src/lib/types.ts`: add `result?: string` to the `ClosedTask` interface.
- `src/lib/task-queue.ts:closeTask`: add `result: task.result` to the object spread when constructing `ClosedTask`. `task.result` is already present on `ActiveTask` (set by `completeTask`).
- `src/extensions/agents/commands.ts`: new `/team-history [teamId]` command that calls `readQueue`, filters to `queue.closed`, renders a table: `[timestamp] [worker] [title truncated] — [result truncated to 100 chars]`.
- Optionally write closed task results to `~/.pi/agent/memory-index.jsonl` (from C2) as a fast cross-session memory layer before the full indexer is built.

**Dependencies.** None.

**Priority.** 2

---

## Category D — Instance Discoverability

> Pain: "hard to tell where I have pi instances running"
>
> Root cause (from `review-agents-extension.md §5`): no cross-repo view; no global registry; `rediscoverTeams` is cwd-scoped; standalone pi instances are invisible.

---

### D1. Global Pi Registry and Fleet Dashboard

**Concept.** Write `~/.pi/agent/running-teams.json` on every `launchTeam`; remove the entry on every `stopTeam`. A standalone `fleet.mjs` dashboard (analogous to `board.mjs` but multi-team) reads this file, checks liveness for each entry, and renders a compact multi-team summary in a terminal pane. A `/pi-fleet` command in any pi instance launches or attaches to the fleet dashboard.

**Why it matters.** The agents review documents the exact gap: "after a machine restart or tmux session detach, the only recovery path is opening pi in the exact repo the team was launched from." The global registry is a prerequisite for all other discoverability features. The fleet dashboard gives a single pane of glass for all running agents without requiring the user to know which repos have active teams.

**Scope.** M (2-3 days)

**Architecture.**

**Registry writes:**
- `src/extensions/agents/launcher.ts:launchTeam` (after successful tmux session creation): append to `~/.pi/agent/running-teams.json` — `{ teamId, goal, tmuxSession, repoRoot, queuePath, createdAt }`. File is a JSON array; use the write-to-temp-then-rename pattern from `shared-state.ts` for atomicity.
- `launcher.ts:stopTeam`: remove the entry for `teamId` from the registry file.

**Registry reads:**
- New `src/lib/team-registry.ts`: `readRegistry()`, `addTeam(entry)`, `removeTeam(teamId)`, `listLiveTeams()` (reads registry, cross-checks each entry against `sessionExists(tmuxSession)`, returns live subset).

**Fleet dashboard (`fleet.mjs`):**
- Standalone Node ESM script (same pattern as `board.mjs` — no transpilation, no deps beyond `node:fs`).
- Reads `~/.pi/agent/running-teams.json` every 5 seconds.
- For each entry: calls `readQueue(queuePath)` for task counts; calls `tmux list-windows -t <session>` for window count; checks `sessionExists`.
- Renders a table: `TEAM | GOAL | REPO | QUEUED | ACTIVE | REVIEW | CLOSED | WINDOWS | AGE`.
- Dead sessions (queue file present but tmux session gone) shown in a "stale" section with the option to clean up via a keypress.

**`/pi-fleet` command:**
- Added to `src/extensions/agents/commands.ts`.
- If fleet window already exists in the current tmux session: `tmux select-window -t fleet`.
- If not: creates a new window and runs `node ~/.pi/agent/fleet.mjs` (or from the package install path).

**Dependencies.** No new npm packages. `fleet.mjs` copies the vanilla Node pattern from `board.mjs`.

**Priority.** 1

---

### D2. `/pi-status` Fleet Command

**Concept.** A lighter-weight, in-TUI complement to the fleet dashboard. `/pi-status` renders a one-shot snapshot of all running teams (reading from the global registry from D1) directly in the pi chat pane — task counts, goals, tmux session names — without launching a separate window.

**Why it matters.** The fleet dashboard (D1) requires tmux to be active. `/pi-status` works from any pi session, including headless or remote SSH sessions where launching a separate tmux window isn't practical. It is the equivalent of `docker ps` — a quick status check without a full monitoring UI.

**Scope.** S (< 1 day; depends on D1 registry)

**Architecture.**
- New command `/pi-status` in `src/extensions/agents/commands.ts`.
- Calls `listLiveTeams()` from `team-registry.ts` (D1).
- For each live team: calls `readQueue(entry.queuePath)` and `listWindows(entry.tmuxSession)`.
- Formats and sends as a notify message: a markdown table of active teams.
- Also lists standalone pi instances by scanning `tmux list-sessions` for sessions that are NOT in the registry (indicating a non-team pi invocation) and reporting their session names.

**Dependencies.** D1 (global registry). If D1 is not yet implemented, falls back to scanning the current repo's worktrees dir (existing `rediscoverTeams` behavior) — same output, narrower scope.

**Priority.** 2

---

### D3. tmux Status-Right Integration

**Concept.** A shell script that reads `~/.pi/agent/running-teams.json` and emits a compact string suitable for `tmux status-right` (e.g., `[pi: 2 teams · 4▶ 1✓]`). A `/pi-statusbar-install` command writes the tmux config snippet to `~/.tmux.conf.d/pi.conf` and reloads tmux config.

**Why it matters.** The status bar is always visible regardless of which tmux window is focused. A passive indicator — "pi has 4 active workers" — surfaces context without requiring the user to run a command. Particularly useful when working in a non-pi terminal window while agents run in the background.

**Scope.** S (< 1 day; depends on D1 registry)

**Architecture.**
- New `src/extensions/agents/scripts/pi-status.sh`:
  ```sh
  #!/bin/sh
  REG=~/.pi/agent/running-teams.json
  [ -f "$REG" ] || exit 0
  TEAMS=$(jq 'length' "$REG")
  ACTIVE=$(jq '[.[].queuePath] | map(. as $p | try (path($p) | fromjson) | .active | length) | add // 0' "$REG")
  echo "[pi: ${TEAMS}t · ${ACTIVE}▶]"
  ```
  (Simplified; the real version reads queue files directly with `node -e` for portability and correctness.)
- `pi-statusbar-install` command: appends `set -g status-right "$(~/.pi/agent/pi-status.sh) ..."` to `~/.tmux.conf.d/pi.conf`; runs `tmux source ~/.tmux.conf`.
- Respects existing `status-right` content by appending rather than replacing.

**Dependencies.** `jq` (typically available; fallback to inline `node -e` JSON parsing).

**Priority.** 3

---

## Category E — Phone and Slack Interaction

> Pain: user wants to interact with pi agents from phone or Slack.
>
> The queue file is the natural integration point — any process that can write a valid `Task` entry with proper locking can dispatch work to a running team without touching the agent runtime.

---

### E1. Slack → Pi Queue Bridge (Inbound)

**Concept.** A lightweight Express webhook server runs as a background tmux window alongside the team. It receives Slack slash commands (`/pi <task description>`) or `@pi` mentions, validates the Slack request signature, and appends the task to the team's queue file via the standard `withQueueLock` + `addTask` mechanism. The existing team agent runtime picks up the task with no changes.

**Why it matters.** The ecosystem research documents the official Claude Code Slack integration and a community DIY Slack/Telegram pipeline as validated patterns for async task dispatch. The pi queue-file architecture makes this trivial to integrate: the webhook does exactly one thing — write a task to a file — and the existing runtime handles the rest.

**Scope.** M (2-3 days including Slack app setup and auth)

**Architecture.**

```
Phone / Slack → Slack API → Webhook Server → Queue File → Team Agent Runtime
                                ↑
                         (runs in tmux window "pi-slack")
```

**Webhook server** (`src/extensions/agents/slack/webhook-server.ts`):

```typescript
// Express app, ~100 lines
import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { withQueueLock, addTask, readQueue } from "../../../../lib/task-queue.js";

export function startSlackWebhook(config: SlackWebhookConfig): void {
  const app = express();
  app.use(express.raw({ type: "application/x-www-form-urlencoded" }));

  app.post("/slack/commands", (req, res) => {
    if (!verifySlackSignature(req, config.signingSecret)) {
      res.status(401).send("Unauthorized");
      return;
    }
    const { text, user_id, channel_id } = parseSlackPayload(req.body);
    if (!config.allowedUsers.includes(user_id)) {
      res.json({ response_type: "ephemeral", text: "Not authorized." });
      return;
    }
    // Respond immediately (Slack requires < 3s)
    res.json({ response_type: "ephemeral", text: `Task queued: "${text}"` });
    // Async: write to queue
    enqueueSlackTask({ text, user_id, channel_id }, config).catch(console.error);
  });

  app.listen(config.port, () => console.log(`pi-slack webhook on :${config.port}`));
}

async function enqueueSlackTask(payload, config) {
  const queue = await readQueue(config.queuePath);
  await withQueueLock(config.queuePath, queue, async (q) => {
    return addTask(q, {
      title: payload.text.slice(0, 80),
      description: payload.text,
      metadata: { source: "slack", slackUserId: payload.user_id, channelId: payload.channel_id },
    });
  });
  // Post confirmation back to Slack channel
  await postSlackMessage(payload.channel_id, `Task added to queue: "${payload.text}"`, config.botToken);
}
```

**Configuration:**
- `SLACK_SIGNING_SECRET` — Slack app signing secret (for HMAC request verification).
- `SLACK_BOT_TOKEN` — bot token for posting replies back to Slack.
- `SLACK_ALLOWED_USERS` — comma-separated Slack user IDs.
- `PI_SLACK_PORT` — webhook port (default 3141).
- Per-team config: the target `queuePath` is derived from the team ID, stored in the Slack bot config file at `~/.pi/agent/slack-config.json`.

**Launching:**
- `/team-slack-enable [teamId]` command: creates a new tmux window `pi-slack` in the team's session, runs `node src/extensions/agents/slack/server.mjs` with the config env vars.
- For local dev without a public IP: the command optionally starts `cloudflared tunnel --url http://localhost:3141` and prints the public URL for the user to paste into the Slack app's slash command URL field.

**Security model:**
1. HMAC signature verification on every request (Slack standard; prevents request forgery).
2. User ID allowlist (`SLACK_ALLOWED_USERS`) — only the owner can dispatch tasks.
3. Tasks tagged with `{ source: "slack" }` in metadata — auditable in the queue.
4. No shell execution in the webhook server itself — it only writes JSON to a file.

**Dependencies.** `express` (~no extra weight; or use Node's built-in `http` module to avoid it entirely), `cloudflared` binary for tunneling (optional).

**Priority.** 2

---

### E2. Outbound Webhook Notification System

**Concept.** At key lifecycle events (task complete, task enters review, task auto-rejected, team finished), pi calls a configured webhook URL with a structured JSON payload. The webhook can be a Slack Incoming Webhook, a custom server, or any service that accepts POST. No Slack app required on the receiving end — the user configures a single URL.

**Why it matters.** The inbound bridge (E1) handles dispatching tasks from phone/Slack. The outbound system closes the loop: the user gets a Slack message (or push notification, or SMS via a relay) when their task is done, without polling. This works even for teams that don't use E1 — any team can emit notifications with a one-line config addition.

**Scope.** S (< 1 day; can ship before E1 since it has no inbound dependency)

**Architecture.**
- New `src/lib/notifier.ts` (~60 lines):
  ```typescript
  interface NotifyPayload {
    event: "task_complete" | "task_review" | "task_rejected" | "team_done" | "task_blocked";
    teamId: string;
    taskId: string;
    title: string;
    result?: string;
    repo: string;
    timestamp: number;
  }

  export async function notify(payload: NotifyPayload, webhookUrl: string): Promise<void> {
    // Fire-and-forget; errors are logged but not thrown
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => console.error("[notifier] webhook failed:", err));
  }
  ```
- Call sites:
  - `review.ts:handleClose` → `notify({ event: "task_complete", ... })`
  - `review.ts:handleWait` (when surfacing structural conflicts) → `notify({ event: "task_blocked", ... })`
  - `dispatch.ts:autoRejectTask` → `notify({ event: "task_rejected", ... })`
- Webhook URL configured via `PI_NOTIFY_WEBHOOK` env var or per-team in the team config JSON. If absent, all notify calls are no-ops.
- For Slack: user creates a Slack Incoming Webhook in their workspace settings (2 minutes, no app review required), pastes URL into `PI_NOTIFY_WEBHOOK`. No Slack app, no slash command configuration.
- Message format for Slack-compatible webhooks: `{ "text": "✓ Task complete: <title>\n<result>" }`.

**Dependencies.** Node's built-in `fetch` (Node 18+). No new npm packages.

**Priority.** 1 (ships before E1; useful standalone; makes E1 more valuable by closing the response loop)

---

### E3. SSH + Tailscale Mobile Access Guide and Setup Command

**Concept.** A `/pi-mobile-setup` command that prints a step-by-step guide for setting up Tailscale + SSH + tmux access from a phone, validated against the user's actual machine state (checks if `tailscaled` is running, if a tmux session is active, which port SSH is on). Includes iOS (Terminus) and Android (Termux) app recommendations and a pre-built `~/.ssh/config` snippet for the pi machine.

**Why it matters.** The ecosystem research documents SSH + Tailscale + tmux as the most-cited reliable mobile workflow for terminal-based agents, cited by multiple independent sources. The setup has 6-8 manual steps that are well-understood but tedious. A guided setup command reduces friction to zero for users who don't know where to start. This is the mobile access path that works today without any new infrastructure — the Slack bridge (E1) is complementary, not a replacement.

**Scope.** S (< 1 day)

**Architecture.**
- New command `/pi-mobile-setup` in `src/extensions/agents/commands.ts` (or a top-level pi command).
- The command runs a series of `execFileSync` checks:
  1. `which tailscale` → is Tailscale CLI installed?
  2. `tailscale status --json` → is Tailscale connected? What is the Tailscale IP of this machine?
  3. `systemctl is-active ssh` (or `launchctl list com.openssh.sshd` on macOS) → is SSH daemon running?
  4. `tmux list-sessions` → are pi sessions currently persisted?
- Outputs a tailored guide based on what's already configured and what's missing.
- Generates and prints an `~/.ssh/config` snippet: `Host pi-dev\n  HostName <tailscale-ip>\n  User <whoami>\n  ServerAliveInterval 60`.
- Generates a `tmux new-session -A -s pi` one-liner the user can paste into their phone terminal.
- Optionally installs `mosh` (better than SSH on mobile networks) if not present.

**Dependencies.** `tailscale` CLI, `mosh` — both optional. Command degrades gracefully if neither is installed, printing install instructions instead.

**Priority.** 3

---

## Summary Priority Matrix

| # | Proposal | Category | Scope | Priority |
|---|---|---|---|---|
| B2 | Fix LSP silent empty-success + bootstrap timestamp | B | S | **1** |
| A2 | Full patch review panel at accept time | A | M | **1** |
| C1 | `session-memory.md` per-worktree context file | C | S | **1** |
| D1 | Global pi registry + fleet dashboard | D | M | **1** |
| B1 | `lsp_status` tool + session-start steer message | B | S | **1** |
| E2 | Outbound webhook notification system | E | S | **1** |
| A1 | `worktree_diff` tool | A | S | **2** |
| B3 | Eager LSP server spawn at worktree creation | B | M | **2** |
| C2 | Global session index + `/pi-memory` query | C | L | **2** |
| C3 | Preserved task results + `/team-history` command | C | S | **2** |
| D2 | `/pi-status` fleet command | D | S | **2** |
| E1 | Slack → pi queue bridge (inbound) | E | M | **2** |
| A3 | External diff tool passthrough (delta/difftastic) | A | S | **3** |
| D3 | tmux status-right integration | D | S | **3** |
| E3 | SSH + Tailscale mobile access setup command | E | S | **3** |

**Recommended first sprint (Priority 1, combined ≤ 1 week):** B2 → A2 → C1 → D1 → B1 → E2. These six touch five different files, have no inter-dependencies (except E2 reading the runtime events that already exist), and together close the four stated pain points and the phone/notification gap.
