/**
 * Tool registration for the worktree extension.
 *
 * Each function takes the shared ExtensionState and a tool registrar
 * callback. This keeps tool definitions out of index.ts while avoiding
 * any direct imports from `@mariozechner/pi-coding-agent`.
 */

import { worktreeList } from "../../lib/git.js";
import { createTask, getActiveTask } from "./manager.js";
import type { ExtensionState } from "./extension-state.js";

// ---------------------------------------------------------------------------
// Types for the registrar callback (mirrors pi's registerTool shape)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's registerTool uses complex generic types from typebox
type ToolRegistrar = (def: any) => void;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all worktree tools.
 *
 * @param es          - Shared extension state.
 * @param register    - The `pi.registerTool` function.
 * @param TypeObject  - `Type.Object` from typebox (passed in to avoid importing).
 * @param TypeString  - `Type.String` from typebox.
 */
export function registerWorktreeTools(
  es: ExtensionState,
  register: ToolRegistrar,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typebox schema constructors
  TypeObject: (...args: any[]) => any,
  TypeString: (...args: any[]) => any,
): void {
  register({
    name: "worktree_status",
    label: "Worktree Status",
    description: "Show the current active worktree, branch, task description, and checkpoint history.",
    promptSnippet: "Show active worktree, branch, and checkpoint history",
    promptGuidelines: [
      "Use worktree_status at the start of a session to understand the current task context.",
    ],
    parameters: TypeObject({}),

    async execute() {
      if (!es.repoRoot) {
        return { content: [{ type: "text", text: "Not in a git repository." }], details: {} };
      }

      const activeTask = getActiveTask(es.state);
      const allTasks = Array.from(es.state.tasks.values()).filter((t) => t.status === "active");

      const lines: string[] = [];
      lines.push(`Repository: ${es.repoRoot}`);
      lines.push(`Auto-accept: ${es.autoAccept ? "ON" : "OFF"}`);

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
          if (t.id !== es.state.activeTaskId) {
            lines.push(`  ${t.branchName} — ${t.description}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { activeTaskId: es.state.activeTaskId, taskCount: allTasks.length },
      };
    },
  });

  register({
    name: "worktree_create",
    label: "Create Worktree",
    description: "Create a new task worktree branched from main. Each task gets an isolated directory and branch.",
    promptSnippet: "Create a new task worktree for isolated feature work",
    promptGuidelines: [
      "Create a worktree when starting a new feature or when the user's request is unrelated to the current task.",
      "Always confirm with the user before creating a new worktree.",
    ],
    parameters: TypeObject({
      description: TypeString({ description: "Short description of the task or feature" }),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      if (!es.repoRoot) {
        return { content: [{ type: "text", text: "Not in a git repository." }], details: {}, isError: true };
      }

      const result = await createTask(es.gitCtx(es.repoRoot), params.description as string);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Failed to create task: ${result.error}` }], details: {}, isError: true };
      }

      const task = result.value;
      es.state.tasks.set(task.id, task);
      es.state.activeTaskId = task.id;
      es.persistState();

      return {
        content: [{
          type: "text",
          text: [
            `Created task: ${task.description}`,
            `Branch: ${task.branchName}`,
            `Worktree: ${task.worktreePath}`,
            "",
            "All file operations are now redirected to this worktree.",
          ].join("\n"),
        }],
        details: { taskId: task.id },
      };
    },
  });

  register({
    name: "worktree_list",
    label: "List Worktrees",
    description: "List all task worktrees and their status.",
    promptSnippet: "List all active task worktrees",
    parameters: TypeObject({}),

    async execute() {
      if (!es.repoRoot) {
        return { content: [{ type: "text", text: "Not in a git repository." }], details: {} };
      }

      const gitWorktrees = await worktreeList(es.gitCtx(es.repoRoot));
      const allTasks = Array.from(es.state.tasks.values());

      const lines: string[] = [];
      lines.push(`Tasks (${allTasks.length}):\n`);

      for (const task of allTasks) {
        const isActive = task.id === es.state.activeTaskId;
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
}
