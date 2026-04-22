---
name: worktree-workflow
description: Git worktree management for feature isolation and checkpointing. Use when starting new features, switching between tasks, or reviewing the current work context.
---

# Worktree Workflow

## Overview

This project uses git worktrees to isolate feature work. Each task gets its own
worktree — a separate directory on a dedicated branch. **The main branch stays
clean and is never committed to directly.**

Task state is shared across pi sessions via an atomic shared state file
(`<repo>-worktrees/.harness.json`). This means multiple pi instances can see
each other's worktrees, descriptions, and checkpoint history without conflicts.

## Before Starting Work

1. **Always** run `worktree_status` to check the current context
2. If no active worktree exists and the user is requesting feature work, create one with `worktree_create`
3. If the current worktree does not match the user's request, propose creating a new one

## During Work

- All file operations (read, write, edit, bash) are automatically redirected to the active worktree
- You do not need to use absolute paths — relative paths resolve to the worktree
- Checkpoints are committed automatically after each interaction when files change
- Work as you normally would

## When To Create a New Worktree

Create a new worktree when:
- The user starts a distinctly different feature or task
- The user explicitly asks for one
- There is no active worktree and the user requests code changes

Do NOT create a new worktree when:
- The user's request is a continuation of the current task
- The user is asking questions or reviewing (no code changes needed)
- The user is fixing a bug found during the current task

**Always confirm with the user before creating a new worktree.**

## Completing Work

The user manages task lifecycle via slash commands:
- `/wt-accept` — squash-merges the task branch into main and cleans up
- `/wt-reject` — discards the worktree and branch
- `/wt` — switches between active tasks
- `/wt-update` — merges latest main into the current task branch

There is also an **auto-accept mode** (`/wt-auto`) that automatically merges the
task branch into main at the end of each agent turn (after checkpointing). The
current mode is shown in the powerline toolbar as `[wt: auto-accept]` or
`[wt: manual]`.

You do not need to call these. Inform the user when a task feels complete so they can decide.

## Parallel Agents and Updating from Main

Multiple pi instances can work on different worktrees simultaneously. When agents
run in parallel, their branches may fall behind main as other tasks get accepted.

### The problem

Agent A and Agent B both branch from main. Agent A finishes first and its work is
accepted (`/wt-accept`), advancing main. Agent B's branch is now behind — it does
not have Agent A's changes. If Agent B's work depends on or conflicts with those
changes, merging will be harder.

### The solution

Use `/wt-update` to merge the latest main into the current task branch. This
command:

1. **Checkpoints** any uncommitted changes in the worktree automatically
2. **Merges** the current main into the task branch (fast-forward when possible,
   merge commit when branches have diverged)
3. Reports the new HEAD SHA

### When to update

- **Before accepting** — if main has advanced since the branch was created, update
  first to catch conflicts early rather than at merge time.
- **After a sibling task merges** — if another agent's work was just accepted and
  your task touches related files, update to incorporate those changes.
- **When the user asks** — the user may know that another agent has finished and
  want you to pick up its changes.

### When NOT to update

- If the task is about to be accepted anyway and the changes are independent —
  the squash-merge will handle it.
- If you are unsure whether main has changed — ask the user rather than updating
  speculatively.

**Important:** If the merge produces conflicts, git will report them in the
`/wt-update` output. Resolve conflicts manually before continuing work.

## Cross-Session State

Worktree metadata is persisted in two places:
1. **Pi session entries** — restored when the same session resumes.
2. **Shared state file** (`<repo>-worktrees/.harness.json`) — read by all pi
   instances on startup so tasks created in one session appear in another.

The shared file uses atomic writes (write-to-temp, then rename) to avoid
corruption when multiple instances write simultaneously. Git remains the source
of truth for which worktrees exist; the shared file provides supplementary
metadata like descriptions and checkpoint history.

On startup the extension merges tasks from both the shared file and git
discovery, notifying how many new tasks were found.

Additionally, tools and commands that read the task list (e.g., `worktree_status`,
`worktree_list`, `/wt`) refresh from the shared state file on demand before
returning results. This ensures you always see up-to-date tasks from other
sessions without requiring a restart.

## Key Principles

- **Never commit directly to main**
- **One worktree per feature or task**
- Let the extension handle checkpointing automatically
- Use `worktree_status` to orient yourself at the start of every session
- When uncertain whether a request is a new task, ask the user
- Tasks are visible across pi sessions — another instance may already be working on a worktree
- When working in parallel, use `/wt-update` to stay current with main before merging
- Auto-accept mode status is shown in the powerline toolbar
