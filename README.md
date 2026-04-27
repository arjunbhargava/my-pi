# my-pi

Personal extensions for [pi](https://github.com/badlogic/pi-mono).

| Extension | What it does |
|-----------|-------------|
| **worktree** | Single-task workflow — isolated git worktrees, auto-checkpoints, squash-merge on accept |
| **agents** | Multi-agent teams — orchestrator decomposes goals, workers execute in parallel worktrees, evaluator merges |
| **websearch** | Web search and page fetching via Tavily + Browserbase |

Each extension has its own README with usage details.

## Installation

### Globally (recommended)

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/my-pi/src/extensions/worktree",
    "/path/to/my-pi/src/extensions/agents",
    "/path/to/my-pi/src/extensions/websearch"
  ]
}
```

### Per-project

Reference as a package in the project's `.pi/settings.json`:

```json
{
  "packages": ["/path/to/my-pi"]
}
```

This picks up all extensions via the `pi.extensions` field in `package.json`.

### One-shot

```bash
pi -e /path/to/my-pi/src/extensions/worktree/worktree.ts
```

> **Note:** Symlinking into `.pi/extensions/` does not work — Node resolves imports relative to the symlink location, breaking relative paths.

## License

Private. Personal use only.
