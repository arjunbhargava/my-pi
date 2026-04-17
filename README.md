# my-pi

Personal coding harness for [pi](https://github.com/badlogic/pi-mono). Provides git worktree management, automatic checkpointing, and task isolation for agentic coding sessions.

## What It Does

Every time you ask pi to work on a feature, my-pi:

1. **Creates a worktree** — an isolated working directory on its own git branch, so your main branch stays clean
2. **Checkpoints automatically** — commits a snapshot after each agent interaction, giving you full undo history
3. **Accepts or rejects** — when a feature is done, squash-merge it into main with one command, or discard it entirely

## Installation

Reference my-pi as a package in any project's `.pi/settings.json`:

```json
{
  "packages": ["/path/to/my-pi"]
}
```

Or load it directly for a single session:

```bash
pi -e /path/to/my-pi/src/extensions/worktree/index.ts
```

## Usage

### Starting a Task

Create a new worktree when beginning feature work. The agent will do this via the `worktree_create` tool, or you can use the command directly:

```
/wt-new add user authentication
```

This creates:
- Branch: `task/add-user-authentication`
- Directory: `../your-repo-worktrees/add-user-authentication/`

All file operations (read, write, edit, bash) are automatically redirected to the worktree.

### During Work

Work normally. Checkpoints are committed automatically after each agent interaction. You can see your current state anytime:

```
Ask the agent: "what's the current worktree status?"
```

### Switching Tasks

If you have multiple tasks in progress:

```
/wt
```

### Completing a Task

Accept (squash-merge into main):

```
/wt-accept
```

Reject (discard worktree and branch):

```
/wt-reject
```

## Commands

| Command | Description |
|---------|-------------|
| `/wt` | Switch between active task worktrees |
| `/wt-new <description>` | Create a new task worktree |
| `/wt-accept [message]` | Squash-merge current task into main |
| `/wt-reject` | Discard current task's worktree and branch |

## Tools (Available to the Agent)

| Tool | Description |
|------|-------------|
| `worktree_status` | Show active worktree, branch, and checkpoint history |
| `worktree_create` | Create a new task worktree branched from main |
| `worktree_list` | List all task worktrees and their status |

## Project Structure

```
my-pi/
├── src/
│   ├── lib/
│   │   ├── types.ts              # Shared types (git context, result types)
│   │   └── git.ts                # Git command wrappers
│   └── extensions/
│       └── worktree/
│           ├── index.ts          # Extension entry point
│           ├── types.ts          # Extension-specific types
│           ├── checkpoint.ts     # Automatic checkpoint commits
│           ├── manager.ts        # Worktree/task lifecycle
│           └── accept-reject.ts  # Squash-merge and discard logic
├── skills/
│   └── worktree-workflow/
│       └── SKILL.md              # Teaches the agent worktree conventions
├── AGENTS.md                     # Coding standards for this repo
├── package.json                  # Pi package manifest
└── tsconfig.json
```

## Roadmap

- **Multi-agent orchestration** — multiple pi instances in tmux panes, coordinated via event bus
- **External messaging** — Slack bridge for agent notifications
- **Persistent memory** — cross-session knowledge storage
- **Docker support** — containerized worktree environments

## License

Private. Personal use only.
