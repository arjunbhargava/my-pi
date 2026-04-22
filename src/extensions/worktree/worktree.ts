/**
 * Worktree extension entry point.
 *
 * Wires git worktree management into pi via event hooks, then delegates
 * tool and command registration to dedicated modules. This is the only
 * file in the extension that imports from `@mariozechner/pi-coding-agent`.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getRepositoryRoot } from "../../lib/git.js";
import type { GitContext } from "../../lib/types.js";
import { acceptTask } from "./accept-reject.js";
import { createCheckpoint } from "./checkpoint.js";
import { registerWorktreeCommands } from "./commands.js";
import type { ExtensionState } from "./extension-state.js";
import { discoverTasksFromGit, getActiveTask } from "./manager.js";
import {
  readSharedState,
  removeTaskFromSharedState,
  setActiveTaskInSharedState,
  updateTaskInSharedState,
} from "./shared-state.js";
import { registerWorktreeTools } from "./tools.js";
import {
  CONTEXT_MESSAGE_TYPE,
  STATE_ENTRY_TYPE,
  type SerializedHarnessState,
  createEmptyState,
  deserializeState,
  serializeState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/** Resolve relative paths to the active worktree. Absolute/~ paths pass through. */
function resolveToWorktree(worktreePath: string, filePath: string): string {
  if (path.isAbsolute(filePath) || filePath.startsWith("~")) return filePath;
  return path.join(worktreePath, filePath);
}

/** Shell-safe single-quoted string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

/** Rebuild harness state from pi session custom entries (takes latest snapshot). */
function restoreState(entries: readonly { type: string; customType?: string; data?: unknown }[]): ReturnType<typeof createEmptyState> {
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
  // Skip worktree management when running as a spawned team agent —
  // agents operate in their own worktrees and must not have file paths redirected.
  if (process.env.PI_TEAM_AGENT_CONFIG) return;

  // Shared mutable state, exposed to tools and commands via ExtensionState
  let state = createEmptyState();
  let repoRoot: string | null = null;
  let currentPrompt: string | undefined;
  let autoAccept = false;
  const sessionId = `pi-${Date.now().toString(36)}`;

  function gitCtx(cwd: string): GitContext {
    return { exec: (cmd, args, opts) => pi.exec(cmd, args, opts), cwd };
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY_TYPE, serializeState(state));
    if (repoRoot) syncToSharedState();
  }

  async function syncToSharedState(): Promise<void> {
    if (!repoRoot) return;
    for (const task of state.tasks.values()) {
      await updateTaskInSharedState(repoRoot, task);
    }
    await setActiveTaskInSharedState(repoRoot, sessionId, state.activeTaskId);
  }

  async function mergeFromSharedState(): Promise<number> {
    if (!repoRoot) return 0;
    const shared = await readSharedState(repoRoot);
    if (!shared.ok) return 0;
    const knownPaths = new Set(Array.from(state.tasks.values()).map((t) => t.worktreePath));
    let merged = 0;
    for (const task of Object.values(shared.value.tasks)) {
      if (knownPaths.has(task.worktreePath)) continue;
      state.tasks.set(task.id, task);
      merged++;
    }
    return merged;
  }

  // Build the ExtensionState object that tools/commands use
  const es: ExtensionState = {
    get state() { return state; },
    get repoRoot() { return repoRoot; },
    get autoAccept() { return autoAccept; },
    set autoAccept(v: boolean) { autoAccept = v; },
    sessionId,
    gitCtx,
    persistState,
    async removeFromSharedState(taskId: string) {
      if (repoRoot) await removeTaskFromSharedState(repoRoot, taskId);
    },
    async refreshFromSharedState() {
      if (!repoRoot) return;
      await mergeFromSharedState();
      await discoverTasksFromGit(gitCtx(repoRoot), state);
    },
  };

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

    const mergedFromFile = await mergeFromSharedState();
    const discovered = await discoverTasksFromGit(gitCtx(repoRoot), state);
    const totalNew = mergedFromFile + (discovered.ok ? discovered.value : 0);
    if (totalNew > 0) {
      persistState();
      ctx.ui.notify(`Discovered ${totalNew} task(s) from existing worktrees.`, "info");
    }

    // Status text must start with '[' for powerline-footer compatibility
    ctx.ui.setStatus("worktree", autoAccept ? "[wt: auto-accept]" : "[wt: manual]");
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

  pi.on("agent_end", async (_event, ctx) => {
    if (!repoRoot) return;
    const activeTask = getActiveTask(state);
    if (!activeTask) return;

    const description = currentPrompt ?? "agent changes";
    currentPrompt = undefined;

    // Checkpoint
    try {
      const cpResult = await createCheckpoint(gitCtx(activeTask.worktreePath), description);
      if (cpResult.ok && cpResult.value) {
        activeTask.checkpoints.push(cpResult.value);
        persistState();
      }
    } catch (_err) {
      // Checkpoint failure must not break the session.
    }

    // Auto-accept: squash-merge into main and clean up
    if (autoAccept && repoRoot) {
      const summary = `feat: ${activeTask.description}`;
      const result = await acceptTask(gitCtx(repoRoot), activeTask, summary);
      if (result.ok) {
        activeTask.status = "accepted";
        state.activeTaskId = null;
        await removeTaskFromSharedState(repoRoot, activeTask.id);
        persistState();
        ctx.ui.notify(`Auto-accepted: ${activeTask.description} → ${result.value.slice(0, 8)}`, "info");
      } else {
        ctx.ui.notify(`Auto-accept failed: ${result.error}`, "error");
      }
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    const activeTask = getActiveTask(state);
    if (!activeTask) return;
    const wtp = activeTask.worktreePath;

    if (isToolCallEventType("bash", event)) {
      event.input.command = `cd ${shellQuote(wtp)} && ${event.input.command}`;
      return;
    }
    if (isToolCallEventType("read", event)) {
      event.input.path = resolveToWorktree(wtp, event.input.path);
      return;
    }
    if (event.toolName === "write" && event.input?.path) {
      (event.input as Record<string, unknown>).path = resolveToWorktree(wtp, event.input.path as string);
      return;
    }
    if (event.toolName === "edit" && event.input?.path) {
      (event.input as Record<string, unknown>).path = resolveToWorktree(wtp, event.input.path as string);
    }
  });

  // -----------------------------------------------------------------------
  // Auto-accept keyboard shortcut
  // -----------------------------------------------------------------------

  pi.registerShortcut("ctrl+shift+a", {
    description: "Toggle worktree auto-accept",
    handler: async (ctx) => {
      autoAccept = !autoAccept;
      ctx.ui.setStatus("worktree", autoAccept ? "[wt: auto-accept]" : "[wt: manual]");
      ctx.ui.notify(autoAccept ? "Auto-accept ON" : "Auto-accept OFF", "info");
    },
  });

  // -----------------------------------------------------------------------
  // Delegate tool and command registration
  // -----------------------------------------------------------------------

  registerWorktreeTools(es, pi.registerTool.bind(pi), Type.Object, Type.String);
  registerWorktreeCommands(es, pi.registerCommand.bind(pi));
}
