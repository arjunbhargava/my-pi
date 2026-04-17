# my-pi

Personal coding harness for pi. Provides git worktree management, checkpointing,
and (future) multi-agent orchestration.

## Project Structure

- `src/lib/` — Shared utilities. No pi extension imports here.
- `src/lib/types.ts` — Shared type definitions used across all modules (git context, result types, git data shapes).
- `src/lib/git.ts` — All git command wrappers. The only module that executes git commands.
- `src/extensions/worktree/` — Pi extension for worktree + checkpoint workflow.
- `src/extensions/worktree/index.ts` — Extension entry point. Only file that imports from `@mariozechner/pi-coding-agent`.
- `src/extensions/worktree/types.ts` — Extension-specific type definitions. No logic, no imports beyond other type files.
- `skills/` — Agent skill definitions (SKILL.md files).

## Worktree Workflow

All work happens in isolated worktrees — never edit files directly on main.

- **Starting work**: Always create a worktree (`worktree_create` tool or `/wt-new`) before making any changes. If a session starts without an active worktree, create one before editing files.
- **During work**: Checkpoints are automatic. Use `worktree_status` to check current state.
- **Switching tasks**: Use `/wt` to switch between active worktrees.
- **Completing work**: Use `/wt-accept` to squash-merge into main, or `/wt-reject` to discard.
- **New vs. existing**: If the user's request is unrelated to the current active task, confirm and create a new worktree. Do not mix unrelated changes in one worktree.

## Code Standards

### Naming

- Variables describe what they hold: `taskBranch`, `checkpointSha`, `worktreePath`. Not `str`, `tmp`, `data`.
- Functions describe what they do: `createWorktree`, `commitCheckpoint`. Not `process`, `handle`, `doWork`.
- Boolean variables read as assertions: `isClean`, `hasUnstagedChanges`, `canMerge`.
- Constants are UPPER_SNAKE: `MAX_SLUG_LENGTH`, `WORKTREE_DIR_SUFFIX`.

### Functions

- Single responsibility. If a function does two things, split it.
- Extract shared logic into named helpers — no duplicated blocks.
- Functions that can fail return structured results (`{ ok: true, value } | { ok: false, error }`), not thrown exceptions. Exceptions are for truly unexpected failures (bugs), not for "branch already exists."
- No function exceeds ~80 lines. If it does, decompose it.
- No more than 3 positional parameters. Use an options object beyond that.

### Modules

- Target modules under 300 lines excluding tests.
- If a module exceeds 400 lines, split it before adding more.
- One concept per module. `checkpoint.ts` does checkpointing. It does not also manage worktree lifecycle.

### Types

- No `any`. Use `unknown` and narrow, or define the type.
- Prefer interfaces for object shapes, type aliases for unions/intersections.
- All git interactions go through `src/lib/git.ts`. No raw `exec("git", ...)` calls anywhere else.

### Comments

- Document the "why", not the "what". The code shows the what.
- Every exported function has a JSDoc comment explaining its purpose, parameters, and return value.
- No commented-out code. Delete it; git has history.

### Error Handling

- Never swallow errors silently. At minimum, log them.
- Git operations that can fail (dirty state, missing branch, conflict) must check for and handle those cases explicitly — not catch-all.

## Commands

- After code changes: verify TypeScript compiles with `npx tsc --noEmit`
- Test the extension by running `pi -e src/extensions/worktree/index.ts` in a test repo
- NEVER commit to the my-pi repo unless asked
- NEVER run `npm publish`

## Git Conventions

- Commit messages: `type: concise description` (e.g., `feat: add worktree creation`, `fix: handle dirty state on checkpoint`)
- No emoji in commits or code comments
- Do not commit `node_modules/`, `dist/`, or generated files

## What NOT To Do

- Do not add dependencies without discussing them first
- Do not use `console.log` for user-facing output — use `ctx.ui.notify` or tool results
- Do not make decisions about worktree creation/switching silently — always confirm with the user via `ctx.ui.confirm` or `ctx.ui.select`
- Do not import from `@mariozechner/pi-coding-agent` outside of `index.ts`
- Do not use string literals for repeated values — define constants
