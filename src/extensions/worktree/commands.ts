/**
 * Command registration for the worktree extension.
 *
 * Each command handler receives the shared ExtensionState. Command
 * registrars are passed in as callbacks to avoid importing from
 * `@mariozechner/pi-coding-agent`.
 */

import { getMainBranch, hasUncommittedChanges, logOneline, pushBranch } from "../../lib/git.js";
import { acceptTask, getTaskDiff, rejectTask } from "./accept-reject.js";
import { createCheckpoint } from "./checkpoint.js";
import { createPullRequest } from "./pull-request.js";
import { createTask, getActiveTask, slugify, updateTaskFromMain } from "./manager.js";
import type { ExtensionState, NotifyLevel } from "./extension-state.js";

// ---------------------------------------------------------------------------
// Types for the registrar callback (mirrors pi's registerCommand shape)
// ---------------------------------------------------------------------------

interface CommandUI {
  notify(message: string, level?: NotifyLevel): void;
  confirm(title: string, message: string): Promise<boolean>;
  input(prompt: string, defaultValue?: string): Promise<string | undefined>;
  select(title: string, choices: string[]): Promise<string | undefined>;
  setStatus(id: string, text: string): void;
}

type CommandHandler = (args: string | undefined, ctx: { ui: CommandUI }) => Promise<void>;

type CommandRegistrar = (name: string, opts: {
  description: string;
  handler: CommandHandler;
}) => void;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all worktree commands.
 *
 * @param es       - Shared extension state.
 * @param register - The `pi.registerCommand` function.
 */
export function registerWorktreeCommands(es: ExtensionState, register: CommandRegistrar): void {
  register("wt", {
    description: "Switch between active task worktrees",
    handler: async (_args, ctx) => {
      await es.refreshFromSharedState();
      const activeTasks = Array.from(es.state.tasks.values()).filter((t) => t.status === "active");

      if (activeTasks.length === 0) {
        ctx.ui.notify("No active tasks. Use worktree_create to start one.", "info");
        return;
      }

      const choices = activeTasks.map(
        (t) => `${t.id === es.state.activeTaskId ? "→ " : "  "}${t.description} (${t.branchName})`,
      );

      const choice = await ctx.ui.select("Switch to task:", choices);
      if (!choice) return;

      const selectedIndex = choices.indexOf(choice);
      const selectedTask = activeTasks[selectedIndex];

      es.state.activeTaskId = selectedTask.id;
      es.persistState();
      ctx.ui.notify(`Switched to: ${selectedTask.description}`, "info");
    },
  });

  register("wt-new", {
    description: "Create a new task worktree",
    handler: async (args, ctx) => {
      if (!es.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const rawDescription = args?.trim();
      let description: string;
      if (!rawDescription) {
        const input = await ctx.ui.input("Task description:");
        if (!input) return;
        description = input;
      } else {
        description = rawDescription;
      }

      const result = await createTask(es.gitCtx(es.repoRoot), description);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      const task = result.value;
      es.state.tasks.set(task.id, task);
      es.state.activeTaskId = task.id;
      es.persistState();
      ctx.ui.notify(`Created: ${task.description} → ${task.worktreePath}`, "info");
    },
  });

  register("wt-accept", {
    description: "Accept current task: squash-merge into main and clean up",
    handler: async (args, ctx) => {
      if (!es.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(es.state);
      if (!activeTask) {
        ctx.ui.notify("No active task to accept.", "info");
        return;
      }

      const diff = await getTaskDiff(es.gitCtx(es.repoRoot), activeTask);
      if (diff.ok && diff.value) {
        ctx.ui.notify(`Changes:\n${diff.value}`, "info");
      }

      const confirmed = await ctx.ui.confirm(
        "Accept task?",
        `Squash-merge "${activeTask.description}" into main?`,
      );
      if (!confirmed) return;

      const rawSummary = args?.trim();
      let summary: string;
      if (!rawSummary) {
        const input = await ctx.ui.input("Merge commit message:", `feat: ${slugify(activeTask.description)}`);
        if (!input) return;
        summary = input;
      } else {
        summary = rawSummary;
      }

      const result = await acceptTask(es.gitCtx(es.repoRoot), activeTask, summary);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      activeTask.status = "accepted";
      es.state.activeTaskId = null;
      await es.removeFromSharedState(activeTask.id);
      es.persistState();
      ctx.ui.notify(`Accepted: ${activeTask.description} → ${result.value.slice(0, 8)}`, "info");
    },
  });

  register("wt-pr", {
    description: "Push current task branch and open a GitHub pull request",
    handler: async (args, ctx) => {
      if (!es.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(es.state);
      if (!activeTask) {
        ctx.ui.notify("No active task to open a PR for.", "info");
        return;
      }

      const mainBranch = await getMainBranch(es.gitCtx(es.repoRoot));
      if (!mainBranch.ok) {
        ctx.ui.notify(`Failed: ${mainBranch.error}`, "error");
        return;
      }

      ctx.ui.notify(`Pushing ${activeTask.branchName}...`, "info");
      const push = await pushBranch(es.gitCtx(activeTask.worktreePath), activeTask.branchName);
      if (!push.ok) {
        ctx.ui.notify(`Push failed: ${push.error}`, "error");
        return;
      }

      const rawTitle = args?.trim();
      let title: string;
      if (!rawTitle) {
        const input = await ctx.ui.input("PR title:", activeTask.description);
        if (!input) return;
        title = input;
      } else {
        title = rawTitle;
      }

      const log = await logOneline(es.gitCtx(es.repoRoot), mainBranch.value, activeTask.branchName);
      let body = "";
      if (log.ok && log.value.length > 0) {
        const bullets = log.value.reverse().map((entry) => `* ${entry.subject}`);
        body = bullets.join("\n");
      }

      const pr = await createPullRequest(
        es.gitCtx(activeTask.worktreePath),
        activeTask.branchName,
        { title, body, baseBranch: mainBranch.value },
      );
      if (!pr.ok) {
        ctx.ui.notify(`PR creation failed: ${pr.error}`, "error");
        return;
      }

      ctx.ui.notify(`PR opened: ${pr.value.url}`, "info");
    },
  });

  register("wt-reject", {
    description: "Reject current task: discard worktree and branch",
    handler: async (_args, ctx) => {
      if (!es.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(es.state);
      if (!activeTask) {
        ctx.ui.notify("No active task to reject.", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Reject task?",
        `Discard "${activeTask.description}" and delete its worktree?`,
      );
      if (!confirmed) return;

      const result = await rejectTask(es.gitCtx(es.repoRoot), activeTask);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      activeTask.status = "rejected";
      es.state.activeTaskId = null;
      await es.removeFromSharedState(activeTask.id);
      es.persistState();
      ctx.ui.notify(`Rejected: ${activeTask.description}`, "info");
    },
  });

  register("wt-auto", {
    description: "Toggle auto-accept mode for completed worktrees",
    handler: async (_args, ctx) => {
      es.autoAccept = !es.autoAccept;
      ctx.ui.setStatus("worktree", es.autoAccept ? "[wt: auto-accept]" : "[wt: manual]");
      ctx.ui.notify(
        es.autoAccept
          ? "Auto-accept ON — tasks will be squash-merged after each interaction."
          : "Auto-accept OFF — use /wt-accept to merge manually.",
        "info",
      );
    },
  });

  register("wt-update", {
    description: "Update current task branch by merging latest main into it",
    handler: async (_args, ctx) => {
      if (!es.repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(es.state);
      if (!activeTask) {
        ctx.ui.notify("No active task to update.", "info");
        return;
      }

      const taskCtx = es.gitCtx(activeTask.worktreePath);

      // Checkpoint uncommitted changes before merging
      const dirty = await hasUncommittedChanges(taskCtx);
      if (dirty.ok && dirty.value) {
        ctx.ui.notify("Checkpointing uncommitted changes before update...", "info");
        const cpResult = await createCheckpoint(taskCtx, "pre-update checkpoint");
        if (!cpResult.ok) {
          ctx.ui.notify(`Checkpoint failed: ${cpResult.error}`, "error");
          return;
        }
        if (cpResult.value) {
          activeTask.checkpoints.push(cpResult.value);
          es.persistState();
        }
      }

      const result = await updateTaskFromMain(es.gitCtx(es.repoRoot), taskCtx);
      if (!result.ok) {
        ctx.ui.notify(`Update failed: ${result.error}`, "error");
        return;
      }

      ctx.ui.notify(
        `Updated "${activeTask.description}" from main → ${result.value.slice(0, 8)}`,
        "info",
      );
    },
  });
}
