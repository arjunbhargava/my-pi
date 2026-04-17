/**
 * Worktree extension entry point.
 *
 * Wires git worktree management into pi via event hooks, custom tools,
 * and slash commands. This is the only file in the extension that imports
 * from `@mariozechner/pi-coding-agent`.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getMainBranch, getRepositoryRoot, logOneline, pushBranch, worktreeList } from "../../lib/git.js";
import type { GitContext } from "../../lib/types.js";
import { acceptTask, getTaskDiff, rejectTask } from "./accept-reject.js";
import { createPullRequest } from "./pull-request.js";
import { createCheckpoint } from "./checkpoint.js";
import { createTask, discoverTasksFromGit, getActiveTask, slugify } from "./manager.js";
import {
  CONTEXT_MESSAGE_TYPE,
  type HarnessState,
  STATE_ENTRY_TYPE,
  type SerializedHarnessState,
  createEmptyState,
  deserializeState,
  serializeState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Resolve a file path to the active worktree.
 * Absolute paths and home-relative paths (~) are left unchanged.
 * Relative paths are re-rooted under the worktree directory.
 */
function resolveToWorktree(worktreePath: string, filePath: string): string {
  if (path.isAbsolute(filePath) || filePath.startsWith("~")) return filePath;
  return path.join(worktreePath, filePath);
}

/**
 * Wrap a path in single quotes, escaping any embedded single quotes.
 * Used when injecting paths into shell commands.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/**
 * Rebuild harness state from the pi session's custom entries.
 * Takes the latest snapshot — each `appendEntry` writes a full snapshot.
 */
function restoreState(entries: readonly { type: string; customType?: string; data?: unknown }[]): HarnessState {
  let latest: SerializedHarnessState | null = null;

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
      latest = entry.data as SerializedHarnessState;
    }
  }

  return latest ? deserializeState(latest) : createEmptyState();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function worktreeExtension(pi: ExtensionAPI): void {
  let state: HarnessState = createEmptyState();
  let repoRoot: string | null = null;
  let currentPrompt: string | undefined;

  /** Create a GitContext pointing at the given directory. */
  function gitCtx(cwd: string): GitContext {
    return { exec: (cmd, args, opts) => pi.exec(cmd, args, opts), cwd };
  }

  /** Persist the current state to the pi session. */
  function persistState(): void {
    pi.appendEntry(STATE_ENTRY_TYPE, serializeState(state));
  }

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const rootResult = await getRepositoryRoot(gitCtx(ctx.cwd));
    if (!rootResult.ok) {
      repoRoot = null;
      return;
    }
    repoRoot = rootResult.value;
    state = restoreState(ctx.sessionManager.getEntries());

    // Discover worktrees created by other sessions
    const discovered = await discoverTasksFromGit(gitCtx(repoRoot), state);
    if (discovered.ok && discovered.value > 0) {
      persistState();
      ctx.ui.notify(
        `Discovered ${discovered.value} task(s) from existing worktrees.`,
        "info",
      );
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    currentPrompt = event.prompt;

    if (!repoRoot) return;
    const activeTask = getActiveTask(state);
    if (!activeTask) return;

    return {
      message: {
        customType: CONTEXT_MESSAGE_TYPE,
        content: [
          `Active worktree: \`${activeTask.worktreePath}\``,
          `Branch: \`${activeTask.branchName}\``,
          `Task: ${activeTask.description}`,
          "",
          "All file operations are automatically redirected to this worktree.",
        ].join("\n"),
        display: true,
      },
    };
  });

  pi.on("agent_end", async (_event, _ctx) => {
    if (!repoRoot) return;
    const activeTask = getActiveTask(state);
    if (!activeTask) return;

    const description = currentPrompt ?? "agent changes";
    currentPrompt = undefined;

    try {
      const result = await createCheckpoint(gitCtx(activeTask.worktreePath), description);
      if (result.ok && result.value) {
        activeTask.checkpoints.push(result.value);
        persistState();
      }
    } catch (_err) {
      // Checkpoint failure must not break the session.
      // The user can always commit manually.
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    const activeTask = getActiveTask(state);
    if (!activeTask) return;

    const worktreePath = activeTask.worktreePath;

    if (isToolCallEventType("bash", event)) {
      event.input.command = `cd ${shellQuote(worktreePath)} && ${event.input.command}`;
      return;
    }

    if (isToolCallEventType("read", event)) {
      event.input.path = resolveToWorktree(worktreePath, event.input.path);
      return;
    }

    if (event.toolName === "write" && event.input?.path) {
      (event.input as Record<string, unknown>).path = resolveToWorktree(
        worktreePath,
        event.input.path as string,
      );
      return;
    }

    if (event.toolName === "edit" && event.input?.path) {
      (event.input as Record<string, unknown>).path = resolveToWorktree(
        worktreePath,
        event.input.path as string,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "worktree_status",
    label: "Worktree Status",
    description: "Show the current active worktree, branch, task description, and checkpoint history.",
    promptSnippet: "Show active worktree, branch, and checkpoint history",
    promptGuidelines: [
      "Use worktree_status at the start of a session to understand the current task context.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!repoRoot) {
        return {
          content: [{ type: "text", text: "Not in a git repository." }],
          details: {},
        };
      }

      const activeTask = getActiveTask(state);
      const allTasks = Array.from(state.tasks.values()).filter((t) => t.status === "active");

      const lines: string[] = [];
      lines.push(`Repository: ${repoRoot}`);

      if (activeTask) {
        lines.push(`\nActive task: ${activeTask.description}`);
        lines.push(`Branch: ${activeTask.branchName}`);
        lines.push(`Worktree: ${activeTask.worktreePath}`);
        lines.push(`Checkpoints: ${activeTask.checkpoints.length}`);
        for (const cp of activeTask.checkpoints.slice(-5)) {
          const date = new Date(cp.timestamp).toISOString();
          lines.push(`  ${cp.sha.slice(0, 8)} ${date} — ${cp.description.split("\n")[0]}`);
        }
      } else {
        lines.push("\nNo active task. Use worktree_create to start one.");
      }

      if (allTasks.length > 1) {
        lines.push(`\nOther active tasks (${allTasks.length - 1}):`);
        for (const t of allTasks) {
          if (t.id !== state.activeTaskId) {
            lines.push(`  ${t.branchName} — ${t.description}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { activeTaskId: state.activeTaskId, taskCount: allTasks.length },
      };
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description: "Create a new task worktree branched from main. Each task gets an isolated directory and branch.",
    promptSnippet: "Create a new task worktree for isolated feature work",
    promptGuidelines: [
      "Create a worktree when starting a new feature or when the user's request is unrelated to the current task.",
      "Always confirm with the user before creating a new worktree.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Short description of the task or feature" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!repoRoot) {
        return {
          content: [{ type: "text", text: "Not in a git repository." }],
          details: {},
          isError: true,
        };
      }

      const result = await createTask(gitCtx(repoRoot), params.description);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to create task: ${result.error}` }],
          details: {},
          isError: true,
        };
      }

      const task = result.value;
      state.tasks.set(task.id, task);
      state.activeTaskId = task.id;
      persistState();

      return {
        content: [
          {
            type: "text",
            text: [
              `Created task: ${task.description}`,
              `Branch: ${task.branchName}`,
              `Worktree: ${task.worktreePath}`,
              "",
              "All file operations are now redirected to this worktree.",
            ].join("\n"),
          },
        ],
        details: { taskId: task.id },
      };
    },
  });

  pi.registerTool({
    name: "worktree_list",
    label: "List Worktrees",
    description: "List all task worktrees and their status.",
    promptSnippet: "List all active task worktrees",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!repoRoot) {
        return {
          content: [{ type: "text", text: "Not in a git repository." }],
          details: {},
        };
      }

      const gitWorktrees = await worktreeList(gitCtx(repoRoot));
      const allTasks = Array.from(state.tasks.values());

      const lines: string[] = [];
      lines.push(`Tasks (${allTasks.length}):\n`);

      for (const task of allTasks) {
        const isActive = task.id === state.activeTaskId;
        const marker = isActive ? "→" : " ";
        const statusLabel = task.status.toUpperCase();
        lines.push(`${marker} [${statusLabel}] ${task.description}`);
        lines.push(`    Branch: ${task.branchName}`);
        lines.push(`    Path: ${task.worktreePath}`);
        lines.push(`    Checkpoints: ${task.checkpoints.length}`);
      }

      if (allTasks.length === 0) {
        lines.push("No tasks. Use worktree_create to start one.");
      }

      if (gitWorktrees.ok) {
        lines.push(`\nGit worktrees (${gitWorktrees.value.length}):`);
        for (const wt of gitWorktrees.value) {
          const branchLabel = wt.branch ?? "(detached)";
          const mainLabel = wt.isMainWorktree ? " [main worktree]" : "";
          lines.push(`  ${wt.path} → ${branchLabel}${mainLabel}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { taskCount: allTasks.length },
      };
    },
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("wt", {
    description: "Switch between active task worktrees",
    handler: async (_args, ctx) => {
      const activeTasks = Array.from(state.tasks.values()).filter((t) => t.status === "active");

      if (activeTasks.length === 0) {
        ctx.ui.notify("No active tasks. Use worktree_create to start one.", "info");
        return;
      }

      const choices = activeTasks.map(
        (t) => `${t.id === state.activeTaskId ? "→ " : "  "}${t.description} (${t.branchName})`,
      );

      const choice = await ctx.ui.select("Switch to task:", choices);
      if (!choice) return;

      const selectedIndex = choices.indexOf(choice);
      const selectedTask = activeTasks[selectedIndex];

      state.activeTaskId = selectedTask.id;
      persistState();
      ctx.ui.notify(`Switched to: ${selectedTask.description}`, "info");
    },
  });

  pi.registerCommand("wt-new", {
    description: "Create a new task worktree",
    handler: async (args, ctx) => {
      if (!repoRoot) {
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

      const result = await createTask(gitCtx(repoRoot), description);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      const task = result.value;
      state.tasks.set(task.id, task);
      state.activeTaskId = task.id;
      persistState();
      ctx.ui.notify(`Created: ${task.description} → ${task.worktreePath}`, "info");
    },
  });

  pi.registerCommand("wt-accept", {
    description: "Accept current task: squash-merge into main and clean up",
    handler: async (args, ctx) => {
      if (!repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(state);
      if (!activeTask) {
        ctx.ui.notify("No active task to accept.", "info");
        return;
      }

      // Show diff summary for review
      const diff = await getTaskDiff(gitCtx(repoRoot), activeTask);
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

      const result = await acceptTask(gitCtx(repoRoot), activeTask, summary);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      activeTask.status = "accepted";
      state.activeTaskId = null;
      persistState();
      ctx.ui.notify(`Accepted: ${activeTask.description} → ${result.value.slice(0, 8)}`, "info");
    },
  });

  pi.registerCommand("wt-pr", {
    description: "Push current task branch and open a GitHub pull request",
    handler: async (args, ctx) => {
      if (!repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(state);
      if (!activeTask) {
        ctx.ui.notify("No active task to open a PR for.", "info");
        return;
      }

      const mainBranch = await getMainBranch(gitCtx(repoRoot));
      if (!mainBranch.ok) {
        ctx.ui.notify(`Failed: ${mainBranch.error}`, "error");
        return;
      }

      // Push the branch
      ctx.ui.notify(`Pushing ${activeTask.branchName}...`, "info");
      const push = await pushBranch(gitCtx(activeTask.worktreePath), activeTask.branchName);
      if (!push.ok) {
        ctx.ui.notify(`Push failed: ${push.error}`, "error");
        return;
      }

      // Build PR title and body
      const rawTitle = args?.trim();
      let title: string;
      if (!rawTitle) {
        const input = await ctx.ui.input("PR title:", activeTask.description);
        if (!input) return;
        title = input;
      } else {
        title = rawTitle;
      }

      const log = await logOneline(gitCtx(repoRoot), mainBranch.value, activeTask.branchName);
      let body = "";
      if (log.ok && log.value.length > 0) {
        const bullets = log.value
          .reverse()
          .map((entry) => `* ${entry.subject}`);
        body = bullets.join("\n");
      }

      // Create the PR
      const pr = await createPullRequest(
        gitCtx(activeTask.worktreePath),
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

  pi.registerCommand("wt-reject", {
    description: "Reject current task: discard worktree and branch",
    handler: async (_args, ctx) => {
      if (!repoRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const activeTask = getActiveTask(state);
      if (!activeTask) {
        ctx.ui.notify("No active task to reject.", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Reject task?",
        `Discard "${activeTask.description}" and delete its worktree?`,
      );
      if (!confirmed) return;

      const result = await rejectTask(gitCtx(repoRoot), activeTask);
      if (!result.ok) {
        ctx.ui.notify(`Failed: ${result.error}`, "error");
        return;
      }

      activeTask.status = "rejected";
      state.activeTaskId = null;
      persistState();
      ctx.ui.notify(`Rejected: ${activeTask.description}`, "info");
    },
  });
}
