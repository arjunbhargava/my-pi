---
name: worktree-workflow
description: Git worktree management for feature isolation and checkpointing. Use when starting new features, switching between tasks, or reviewing the current work context.
---

# Worktree Workflow

## Overview

This project uses git worktrees to isolate feature work. Each task gets its own
worktree — a separate directory on a dedicated branch. The main branch stays clean
and is never committed to directly.

## Before Starting Work

1. Run `worktree_status` to check the current context
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

Always confirm with the user before creating a new worktree.

## Completing Work

The user manages task lifecycle via slash commands:
- `/wt-accept` — squash-merges the task branch into main
- `/wt-reject` — discards the worktree and branch
- `/wt` — switches between active tasks

You do not need to call these. Inform the user when a task feels complete so they can decide.

## Key Principles

- Never commit directly to main
- One worktree per feature or task
- Let the extension handle checkpointing automatically
- Use `worktree_status` to orient yourself at the start of a session
- When uncertain whether a request is a new task, ask the user
