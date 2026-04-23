# my-pi

Personal coding harness for [pi](https://github.com/badlogic/pi-mono). Two extensions on top of a shared workspace primitive:

- **Worktree extension** — single-task workflow. Every prompt happens inside an isolated git worktree that's auto-checkpointed after every agent turn and squash-merged into main on accept.
- **Agents extension** — multi-agent team workflow. An orchestrator decomposes a goal into tasks, dispatches worker pi instances into isolated worktrees, and an evaluator reviews and merges their work.

Both flows share the same `lib/workspace.ts` primitive, the same commit-message composer, and the same tmux-based runtime.

## What It Does

### Single-task (`/wt-*` commands)

1. **Creates a worktree** on a dedicated branch; main stays clean.
2. **Checkpoints automatically** after each agent turn — each commit carries the prompt that drove it and the files touched.
3. **Discovers existing worktrees** from git so other pi sessions can see them.
4. **Accepts or rejects** with a rich squash-merge message (all prompts + all file changes) or a clean discard.

### Multi-agent team (`/team-*` commands)

1. **Launches a tmux session** with a live queue viewer plus one window per permanent agent (orchestrator, evaluator, code reviewer).
2. **Orchestrator** decomposes the goal into tasks and dispatches worker pi instances in fresh tmux windows, each with its own isolated worktree.
3. **Workers** complete their task and auto-commit with description + result + file changes.
4. **Evaluator** reviews each task and either closes (squash-merges into the target branch with a rich commit message) or rejects (requeues with feedback).
5. **Code reviewer** watches the target branch as merges land and files follow-up tasks when the emerging codebase drifts, loses test coverage, or accumulates AI slop.
6. **Rediscovers** running teams on pi restart so `/team-status`, `/team-stop`, and `/team-attach` keep working across sessions.
7. **Auto-recovers dead workers** — a worker whose tmux window has vanished has its task requeued and its worktree cleaned up.

## Installation

### Globally (recommended — how my-pi itself is run)

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/my-pi/src/extensions/worktree",
    "/path/to/my-pi/src/extensions/agents"
  ]
}
```

Every pi session picks up both extensions. Spawned team agents inherit them too.

### Per-project

Reference my-pi as a package in the project's `.pi/settings.json`:

```json
{
  "packages": ["/path/to/my-pi"]
}
```

This picks up both extensions via my-pi's `package.json` `pi.extensions` field.

### One-shot testing

Load a single extension directly for one session:

```bash
pi -e /path/to/my-pi/src/extensions/worktree/worktree.ts
pi -e /path/to/my-pi/src/extensions/agents/agents.ts
```

### What does NOT work

Symlinking into `.pi/extensions/` does not work because Node's module resolution resolves imports relative to the symlink location, not the target. The extension's relative imports (`../../lib/git.js`) break.

## Single-task Usage

### Starting a task

```
/wt-new add user authentication
```

Creates:
- Branch: `task/add-user-authentication`
- Directory: `../your-repo-worktrees/add-user-authentication/`

All file operations (`read`, `write`, `edit`, `bash`) are automatically redirected to the worktree.

### During work

Checkpoints commit automatically after each agent turn. Each commit message looks like:

```
checkpoint: add auth middleware

Prompt:
please add auth middleware that validates the JWT on every route

Changes:
- add src/middleware/auth.ts
- modify src/index.ts
```

### Switching / completing

```
/wt                 # switch between active task worktrees
/wt-accept          # squash-merge into main with a rich commit message
/wt-reject          # discard worktree + branch
/wt-pr              # push branch and open a GitHub PR
/wt-update          # merge latest main into the task branch
/wt-auto            # toggle auto-accept (squash on every agent turn)
```

The squash commit on main contains both `Prompts:` (one per checkpoint) and `Changes:` (file-level diff against main).

## Multi-agent Team Usage

### Launching a team

```
/team-start build a login flow with JWT
```

Creates:
- A tmux session `pi-team-build-a-login-flow-with-jwt` with a `board` window showing the live queue.
- One tmux window per permanent agent (`orchestrator`, `evaluator`) running its own pi instance.

Agents are defined in `agents/roles/*.md` (permanent) and `agents/workers/*.md` (ephemeral) as markdown with YAML frontmatter:

```yaml
---
name: orchestrator
description: Decomposes goals into tasks, dispatches workers
model: us.anthropic.claude-opus-4-6-v1
tools: read, grep, find, ls, bash
capabilities: dispatch
---

You are the orchestrator of a development team. ...
```

Capabilities control which tool bundles get registered:
- `dispatch` — can spawn workers and monitor their progress.
- `close` — can approve and merge reviewed tasks.

A permanent agent with no capabilities (like the code reviewer) gets just the all-agent queue tools: `read_queue`, `add_task`, `complete_task`, and `wait_for_merges`. That's enough to watch work land and advise the orchestrator via new tasks.

### During a team run

The orchestrator adds tasks, dispatches workers (each gets its own worktree and branch under `<repo>-worktrees/team-<id>/worker-<name>/`), and monitors the queue via `fs.watch` (no polling). Dead workers are auto-detected via a 10-second heartbeat; tasks from dead windows are requeued.

Workers auto-commit with rich messages; evaluator merges with rich messages. Merging uses a rebase-retry strategy — if another worker landed changes on the target branch since the worker started, the worker's branch is automatically updated from target and the squash is retried.

### Worker types

The orchestrator picks a worker type per task via `dispatch_task`'s `workerType` arg:

- `implementer` (default) — writes code test-first.
- `scout` — reads and reports structured findings; never edits.
- `researcher` — designs and runs experiments to produce numbers.
- `tester` — runs *functional* tests against real systems with the user attached to the tmux window. Use when "code compiles and unit tests pass" isn't enough and you need to know the real end-to-end flow works: cloud provisioning, ML / GPU workloads, rendering and media pipelines, attached hardware, SSO / OAuth, third-party APIs, database migrations at realistic size. The tester asks the user to attach and supply prereqs (credentials, a connected device, a running service), announces each step that costs money or occupies a shared resource, and tears down everything it allocated before completing. If the user can't help right now, the tester switches to a DEFERRED mode — still commits the re-runnable test artifact and files a follow-up task for live verification later. The orchestrator's guidance on when to dispatch lives in `agents/roles/orchestrator.md`.

### Attaching / stopping

```
/team-status        # per-team queue summary + active windows
/team-attach        # print the `tmux attach` command
/team-stop          # kill the tmux session and all agent processes
```

If you quit pi while a team is running and come back later, you'll see `Reattached to N running team(s): …` on startup — the control plane recovers its view by pairing on-disk queue files with live tmux sessions.

## Commands

| Command | Description |
|---------|-------------|
| `/wt` | Switch between active task worktrees |
| `/wt-new <description>` | Create a new task worktree |
| `/wt-accept [message]` | Squash-merge current task into main |
| `/wt-reject` | Discard current task's worktree and branch |
| `/wt-pr [title]` | Push current task branch and open a GitHub PR |
| `/wt-update` | Merge latest main into the current task branch |
| `/wt-auto` | Toggle auto-accept mode |
| `/team-start <goal>` | Launch a multi-agent team to work on a goal |
| `/team-status` | Show status of running teams and their queues |
| `/team-stop` | Stop a running team and kill its tmux session |
| `/team-attach` | Print the `tmux attach` command for a running team |
| `/team-logs` | List past team agent sessions, or render one as a plain-text transcript for `rg` |

## Tools (Available to Agents)

### Worktree extension (all pi sessions)

| Tool | Description |
|------|-------------|
| `worktree_status` | Active worktree, branch, and checkpoint history |
| `worktree_create` | Create a new task worktree branched from main |
| `worktree_list` | All task worktrees and their status |

### Team-agent extension (every spawned team agent)

| Tool | Description |
|------|-------------|
| `read_queue` | Summary of the task queue or details for one task |
| `add_task` | Append a task to the queue |
| `complete_task` | Mark the caller's active task ready for review; auto-commits with description + result + changes |
| `wait_for_merges` | Block until the evaluator closes a new task (i.e., work has landed on the target branch) |

### Orchestrator only (capability: `dispatch`)

| Tool | Description |
|------|-------------|
| `dispatch_task` | Spawn a worker with an isolated worktree in a new tmux window |
| `monitor_tasks` | Wait for queue changes via `fs.watch`; reaps dead workers each heartbeat |
| `check_workers` | Inspect live workers and their recent tmux output |

### Evaluator only (capability: `close`)

| Tool | Description |
|------|-------------|
| `wait_for_reviews` | Block until at least one task is in review |
| `close_task` | Approve; squash-merge worker branch into target with rich commit message |
| `reject_task` | Requeue with feedback; kill the worker and discard its worktree |

## Project Structure

```
my-pi/
├── src/
│   ├── lib/                           # pi-agnostic utilities
│   │   ├── types.ts                   # Shared types (git, result, queue, exec)
│   │   ├── git.ts                     # Git CLI wrappers (only place git is invoked)
│   │   ├── tmux.ts                    # tmux CLI wrappers
│   │   ├── task-queue.ts              # Atomic JSON queue: read/write + mutations
│   │   ├── workspace.ts               # Shared branch+worktree primitives (create/destroy/squash-merge)
│   │   └── commit-message.ts          # Rich commit-message composer used by both extensions
│   └── extensions/
│       ├── worktree/                  # Single-task /wt-* extension
│       │   ├── worktree.ts            # Entry point (only file importing from pi)
│       │   ├── commands.ts            # /wt, /wt-new, /wt-accept, ...
│       │   ├── tools.ts               # worktree_status, worktree_create, worktree_list
│       │   ├── manager.ts             # Worktree/task lifecycle
│       │   ├── checkpoint.ts          # Per-turn rich-message commits
│       │   ├── accept-reject.ts       # Squash-merge / discard
│       │   ├── pull-request.ts        # /wt-pr implementation
│       │   ├── shared-state.ts        # Cross-session task visibility
│       │   ├── extension-state.ts     # Shared state shape
│       │   └── types.ts
│       └── agents/                    # Multi-agent /team-* extension
│           ├── agents.ts              # Control-plane entry (only file importing from pi)
│           ├── commands.ts            # /team-start, /team-status, /team-stop, /team-attach
│           ├── launcher.ts            # tmux session setup + spawnAgentWindow helper
│           ├── discovery.ts           # Rediscover live teams on pi restart
│           ├── agent-config.ts        # Parse agents/roles/*.md and agents/workers/*.md
│           ├── types.ts               # TeamSession, TeamAgentConfig, Capability
│           └── team-agent/            # Extension loaded inside each spawned team agent
│               ├── index.ts           # Registers tool bundles by capability
│               ├── config.ts          # Load TeamAgentConfig from env var
│               ├── session.ts         # Per-turn context injection + status UI
│               ├── runtime.ts         # Shared helpers (git contexts, queue I/O, worker lifecycle)
│               ├── watch.ts           # fs.watch-based wait loop for monitor/wait tools
│               └── tools/
│                   ├── queue.ts       # read_queue, add_task, complete_task (all agents)
│                   ├── dispatch.ts    # dispatch_task, monitor_tasks, check_workers (dispatch cap)
│                   └── review.ts      # wait_for_reviews, close_task, reject_task (close cap)
├── agents/
│   ├── roles/                         # Permanent agents (one window per team)
│   │   ├── orchestrator.md            # capabilities: dispatch
│   │   ├── evaluator.md               # capabilities: close
│   │   └── code-reviewer.md           # capabilities: (none — reads + adds tasks)
│   └── workers/                       # Ephemeral worker templates
│       ├── implementer.md             # writes code, test-first
│       ├── scout.md                   # reads and reports
│       ├── researcher.md              # runs experiments
│       └── tester.md                  # runs functional tests with the human in the loop
├── skills/
│   └── worktree-workflow/SKILL.md     # Teaches the agent worktree conventions
├── scripts/
│   ├── test-unit.sh                   # Runs all unit tests
│   └── test-smoke.sh                  # Queue + agent-config + tsc smoke test
├── tests/                             # Unit + integration tests (tsx, no Jest)
├── AGENTS.md                          # Coding standards for this repo
├── package.json                       # Pi package manifest
└── tsconfig.json
```

## Testing

```bash
./scripts/test-unit.sh      # unit + integration tests (tsc clean, nine test files)
./scripts/test-smoke.sh     # end-to-end smoke via a fixture repo
```

## Roadmap

- **Kill-worker tool** — escape valve for hung workers (alive but not making progress).
- **`check_workers` tmux scrollback** — currently only the visible pane is captured; older output scrolls past.
- **Artifact cleanup** — reap `.team-configs/*.{json,sh,log}` and crashed queue files on `/team-stop`.
- **Docker transport** — replace tmux as the agent spawn mechanism for truly isolated workers.

## License

Private. Personal use only.
