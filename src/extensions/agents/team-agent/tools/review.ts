/**
 * Evaluator-only tools for reviewing, approving, and rejecting tasks.
 *
 *   wait_to_evaluate   — block until tasks are ready; auto-rebase before returning
 *   close_task         — approve; squash-merge the worker's branch
 *   revise_task        — send minor feedback back to the live worker
 *   reject_task        — kill worker, destroy worktree, requeue task
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  type CommitSection,
  composeCommitMessage,
  formatFileChanges,
} from "../../../../lib/commit-message.js";
import {
  classifyConflicts,
  formatConflictDetails,
  type ConflictFileDetail,
} from "../../../../lib/conflict.js";
import {
  diffNameStatus,
  diffNameStatusBetween,
  getHeadSha,
  hasUncommittedChanges,
  stageAll,
  commit as gitCommit,
  type DiffFileEntry,
} from "../../../../lib/git.js";
import {
  closeTask,
  getTaskById,
  getTasksByStatus,
  rejectTask,
  reviseTask,
} from "../../../../lib/task-queue.js";
import type { Task } from "../../../../lib/types.js";
import {
  destroyWorkspace,
  rebaseWorkspace,
  squashMergeWorkspace,
} from "../../../../lib/workspace.js";
import type { TeamAgentRuntime } from "../runtime.js";
import { watchQueueUntil } from "../watch.js";

/**
 * Per-cycle timeout for the internal watch loop (ms). Each cycle is
 * one call to watchQueueUntil; on timeout, the loop restarts silently
 * without returning to the model. 30 minutes is generous — fs.watch
 * provides the real wake-up; this is a safety net.
 */
const WAIT_CYCLE_MS = 30 * 60 * 1000;

/**
 * Heartbeat for wait_to_evaluate. fs.watch catches every queue write,
 * so this is a conservative safety net against missed events on
 * network or virtualised filesystems — not the primary wake source.
 */
const WAIT_HEARTBEAT_MS = 30_000;

/** How many chars of task.result to show in the review summary. */
const RESULT_PREVIEW_CHARS = 200;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReviewTools(pi: ExtensionAPI, runtime: TeamAgentRuntime): void {
  pi.registerTool({
    name: "wait_to_evaluate",
    label: "Wait to Evaluate",
    description:
      "Block until tasks are ready for evaluation. Automatically rebases each task's branch onto the current target branch before returning. Textual rebase conflicts (simple divergence) are auto-rejected and requeued. Structural conflicts (files deleted, renamed, or substantially rewritten on the target branch) are surfaced to you with full context so you can resolve them directly or reject with updated guidance. Retries internally on timeout.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return await handleWait(runtime, signal);
    },
  });

  pi.registerTool({
    name: "close_task",
    label: "Close Task",
    description:
      "Approve and close a reviewed task. Squash-merges the worker's branch into the target branch. The branch has already been rebased so this is a clean delta application. Kills the worker's tmux window on success.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the reviewed task to close" }),
    }),
    async execute(_id, params) {
      return await handleClose(runtime, params.taskId);
    },
  });

  pi.registerTool({
    name: "revise_task",
    label: "Revise Task",
    description:
      "Send minor feedback to a worker whose task is in review. The worker stays alive with its worktree intact and receives the feedback via wait_for_verdict. Use this for small fixes (add a test case, rename a variable, fix a typo). Use reject_task for fundamental problems that need a fresh start.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the reviewed task to revise" }),
      feedback: Type.String({
        description: "Specific, actionable feedback for the worker to address",
      }),
    }),
    async execute(_id, params) {
      return await handleRevise(runtime, params.taskId, params.feedback);
    },
  });

  pi.registerTool({
    name: "reject_task",
    label: "Reject Task",
    description:
      "Reject a reviewed task with feedback. Kills the worker's tmux window, destroys the worktree, and requeues the task for a fresh attempt. Use for fundamental failures where the approach is wrong.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the reviewed task to reject" }),
      feedback: Type.String({
        description: "Specific, actionable feedback for the next worker attempt",
      }),
    }),
    async execute(_id, params) {
      return await handleReject(runtime, params.taskId, params.feedback);
    },
  });

  pi.registerTool({
    name: "resolve_conflicts",
    label: "Resolve Conflicts",
    description:
      "After you have manually applied a worker's changes to the correct files in their worktree "
      + "(resolving a structural conflict), call this to merge the target branch into the worker's "
      + "branch and commit the resolution. This makes the branch a descendant of the target, "
      + "enabling a normal close_task afterwards. Use bash to make the file changes first, then "
      + "call this to finalize. If the merge still conflicts after your edits, returns an error.",
    parameters: Type.Object({
      taskId: Type.String({ description: "ID of the structurally-conflicted task" }),
    }),
    async execute(_id, params) {
      return await handleResolveConflicts(runtime, params.taskId);
    },
  });
}

// ---------------------------------------------------------------------------
// wait_to_evaluate
// ---------------------------------------------------------------------------

async function handleWait(
  runtime: TeamAgentRuntime,
  signal: AbortSignal | undefined,
) {
  let readyTasks: Task[] = [];

  // Internal retry loop: restart the watch on timeout without
  // returning to the model. Only surfaces when there's real work
  // or the session is torn down via abort signal.
  while (!signal?.aborted) {
    const outcome = await watchQueueUntil(
      runtime.queuePath,
      async (queue) => {
        const tasks = getTasksByStatus(queue, "review");
        if (tasks.length > 0) {
          readyTasks = tasks;
          return "done";
        }
        return "continue";
      },
      { signal, timeoutMs: WAIT_CYCLE_MS, heartbeatMs: WAIT_HEARTBEAT_MS },
    );

    if (outcome === "done") break;
    if (outcome === "aborted") {
      return {
        content: [{ type: "text" as const, text: "Wait aborted." }],
        details: {},
      };
    }
    // outcome === "timeout" → loop silently, no model round-trip
  }

  if (signal?.aborted) {
    return {
      content: [{ type: "text" as const, text: "Wait aborted." }],
      details: {},
    };
  }

  // Rebase each task's branch onto current targetBranch before
  // presenting to the evaluator. Classify conflicts to decide
  // whether to auto-reject (textual) or surface for resolution (structural).
  const snapshot = await runtime.loadQueue();
  const rebased: Task[] = [];
  const autoRejected: string[] = [];
  const structuralConflicts: StructuralConflictInfo[] = [];

  // Resolve target branch HEAD once for classification.
  const targetHeadResult = await getHeadSha(runtime.repoGit());
  const targetHead = targetHeadResult.ok ? targetHeadResult.value : undefined;

  for (const task of readyTasks) {
    if (!task.worktreePath || !task.branchName) {
      // No worktree (e.g., code-reviewer report) — pass through as-is.
      rebased.push(task);
      continue;
    }

    const workspaceGit = runtime.worktreeGit(task.worktreePath);
    const rebaseResult = await rebaseWorkspace(workspaceGit, snapshot.targetBranch);

    if (rebaseResult.ok) {
      rebased.push(task);
      continue;
    }

    // Rebase failed — classify the conflict.
    const conflictPaths = rebaseResult.error.conflictPaths;
    const canClassify = task.baseSha && targetHead && conflictPaths.length > 0;

    if (canClassify) {
      const classification = await classifyConflicts(
        runtime.repoGit(),
        task.baseSha!,
        targetHead,
        conflictPaths,
      );

      if (classification.ok && classification.value.kind === "structural") {
        // Structural conflict — surface to evaluator for resolution.
        // Get the worker's diff so the evaluator can see what they did.
        const workerDiff = await diffNameStatusBetween(
          runtime.repoGit(),
          task.baseSha!,
          task.branchName,
        );
        structuralConflicts.push({
          task,
          conflictPaths,
          structuralFiles: classification.value.files,
          workerChangedFiles: workerDiff.ok ? workerDiff.value : [],
        });
        continue;
      }
    }

    // Textual conflict (or classification failed) — auto-reject as before.
    const feedback = `Automatic rejection: ${rebaseResult.error.message}. Rework against the current target branch.`;
    await autoRejectTask(runtime, task, feedback);
    autoRejected.push(`${task.id} (${task.title}): ${rebaseResult.error.message}`);
  }

  const lines: string[] = [];

  if (autoRejected.length > 0) {
    lines.push(`Auto-rejected ${autoRejected.length} task(s) due to textual rebase conflicts:`);
    for (const c of autoRejected) lines.push(`  \u2717 ${c}`);
    lines.push("");
  }

  if (structuralConflicts.length > 0) {
    lines.push(formatStructuralConflicts(structuralConflicts));
    lines.push("");
  }

  if (rebased.length > 0) {
    lines.push("Tasks ready for evaluation (rebased onto current target branch):\n");
    for (const t of rebased) {
      lines.push(`${t.id} — ${t.title}`);
      if (t.result) {
        const preview = t.result.slice(0, RESULT_PREVIEW_CHARS);
        const ellipsis = t.result.length > RESULT_PREVIEW_CHARS ? "..." : "";
        lines.push(`  Result: ${preview}${ellipsis}`);
      }
    }
  } else if (autoRejected.length > 0 && structuralConflicts.length === 0) {
    lines.push("No tasks remain after rebase filtering. Waiting for requeued tasks to be re-dispatched.");
    // Recurse: go back to waiting since all tasks were auto-rejected.
    return await handleWait(runtime, signal);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
}

/**
 * Auto-reject a task due to rebase conflict. Kills the worker,
 * destroys the worktree, and requeues with conflict feedback.
 */
async function autoRejectTask(
  runtime: TeamAgentRuntime,
  task: Task,
  feedback: string,
): Promise<void> {
  const workerName = task.assignedTo;
  if (workerName) await runtime.killWorkerWindow(workerName);

  if (task.worktreePath && task.branchName) {
    await destroyWorkspace(runtime.repoGit(), {
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
  }

  await runtime.withQueueLock((queue) => {
    rejectTask(queue, task.id, feedback, runtime.agentName);
  });
}

// ---------------------------------------------------------------------------
// Structural conflict presentation
// ---------------------------------------------------------------------------

/** Context for a task with a structural rebase conflict. */
interface StructuralConflictInfo {
  task: Task;
  conflictPaths: string[];
  structuralFiles: ConflictFileDetail[];
  workerChangedFiles: DiffFileEntry[];
}

/**
 * Format structural conflict info for the evaluator model.
 *
 * Gives the evaluator enough context to either resolve the conflict
 * directly (by applying the worker's changes to the correct files
 * via bash) or reject the task if the approach is fundamentally invalid.
 */
function formatStructuralConflicts(conflicts: StructuralConflictInfo[]): string {
  const sections: string[] = [];

  sections.push(
    "STRUCTURAL CONFLICTS — these tasks cannot be auto-retried.\n"
    + "The files they target were deleted, renamed, or substantially rewritten on the target branch.\n"
    + "You can resolve these directly (read the worker's diff, apply changes to the correct files\n"
    + "in the worker's worktree via bash, then close_task) or reject_task if the approach is invalid.\n",
  );

  for (const { task, structuralFiles, workerChangedFiles } of conflicts) {
    sections.push(`--- Task: ${task.id} — ${task.title} ---`);
    sections.push(`Worktree: ${task.worktreePath}`);
    sections.push(`Branch: ${task.branchName}`);
    sections.push(`Base SHA (when task branched): ${task.baseSha ?? "(unknown)"}`);
    sections.push("");
    sections.push("What changed on target branch since this task branched:");
    sections.push(formatConflictDetails(structuralFiles));
    sections.push("");
    sections.push("What the worker's branch changed (their intended contribution):");
    for (const f of workerChangedFiles) {
      const dest = f.renamedTo ? ` → ${f.renamedTo}` : "";
      sections.push(`  ${f.status} ${f.path}${dest}`);
    }
    if (task.result) {
      sections.push("");
      sections.push(`Worker's result summary: ${task.result.slice(0, 300)}`);
    }
    sections.push("");
  }

  sections.push(
    "To resolve: use bash to apply the worker's changes to the correct file locations in the\n"
    + "worktree, then call resolve_conflicts to finalize (merges target branch in and commits).\n"
    + "After that, review the result and close_task as normal.\n"
    + "If the approach is fundamentally invalid (not just mislabeled files), use reject_task with\n"
    + "updated feedback describing the new file layout so the next worker targets correctly.",
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// resolve_conflicts
// ---------------------------------------------------------------------------

/**
 * Finalize a structural conflict resolution.
 *
 * After the evaluator has manually applied the worker's changes to the
 * correct files in the worktree (via bash), this function:
 *   1. Stages all changes in the worktree
 *   2. Commits them (so the worker's branch has the corrected state)
 *   3. Merges the target branch into the worker's branch
 *   4. If the merge succeeds, the branch is now a descendant of target
 *      and close_task will work normally
 *
 * If the merge still conflicts, returns an error — the evaluator needs
 * to fix more files before retrying.
 */
async function handleResolveConflicts(runtime: TeamAgentRuntime, taskId: string) {
  const snapshot = await runtime.loadQueue();
  const task = getTaskById(snapshot, taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);
  if (!task.worktreePath || !task.branchName) {
    throw new Error(`Task '${taskId}' has no worktree — cannot resolve conflicts`);
  }

  const workspaceGit = runtime.worktreeGit(task.worktreePath);

  // Stage and commit the evaluator's manual edits.
  const dirty = await hasUncommittedChanges(workspaceGit);
  if (dirty.ok && dirty.value) {
    await stageAll(workspaceGit);
    await gitCommit(workspaceGit, `fix: resolve structural conflict for '${task.title}'`);
  }

  // Now merge the target branch in. If the evaluator's edits correctly
  // placed the worker's changes, this merge should be clean.
  const rebaseResult = await rebaseWorkspace(workspaceGit, snapshot.targetBranch);
  if (!rebaseResult.ok) {
    return {
      content: [{
        type: "text" as const,
        text: `Merge still conflicts after your edits: ${rebaseResult.error.message}\n`
          + `Conflicting files: ${rebaseResult.error.conflictPaths.join(", ")}\n`
          + `Fix the remaining files in the worktree and call resolve_conflicts again.`,
      }],
      details: {},
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `Conflict resolved for '${task.title}'. Branch is now a descendant of the target branch.\n`
        + `Review the final state of the worktree at: ${task.worktreePath}\n`
        + `Then close_task to merge, or reject_task if the result isn't right.`,
    }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// close_task
// ---------------------------------------------------------------------------

async function handleClose(runtime: TeamAgentRuntime, taskId: string) {
  const snapshot = await runtime.loadQueue();
  const task = getTaskById(snapshot, taskId);
  if (!task) throw new Error(`Task '${taskId}' not found`);

  const workerName = task.assignedTo;

  if (task.branchName && task.worktreePath) {
    const commitMessage = await buildCloseCommitMessage(runtime, snapshot.targetBranch, task);

    const mergeResult = await squashMergeWorkspace(
      runtime.repoGit(),
      {
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        baseBranch: snapshot.targetBranch,
      },
      { commitMessage },
    );
    if (!mergeResult.ok) {
      throw new Error(
        `${mergeResult.error} The branch should have been rebased before review. Use reject_task to requeue.`,
      );
    }

    // Stop the worker BEFORE destroying its worktree so we don't yank
    // the cwd out from under a still-live pi process.
    if (workerName) await runtime.killWorkerWindow(workerName);
    await destroyWorkspace(runtime.repoGit(), task as { worktreePath: string; branchName: string });
  } else if (workerName) {
    await runtime.killWorkerWindow(workerName);
  }

  const closed = await runtime.withQueueLock((queue) => {
    const result = closeTask(queue, taskId, runtime.agentName);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });

  // Read updated queue to inform the evaluator about remaining work.
  const updatedQueue = await runtime.loadQueue();
  const remaining = getTasksByStatus(updatedQueue, "queued").length
    + getTasksByStatus(updatedQueue, "active").length
    + getTasksByStatus(updatedQueue, "review").length;

  const lines = [
    `Closed '${closed.title}' after ${closed.attempts} attempt(s). Changes merged into '${snapshot.targetBranch}'.`,
  ];
  if (remaining > 0) {
    lines.push(`\n${remaining} task(s) still pending. Call wait_to_evaluate to continue.`);
  } else {
    lines.push("\nNo tasks remaining. Call wait_to_evaluate — the orchestrator may dispatch follow-ups or terminate you when the session is complete.");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("") }],
    details: {},
  };
}

/**
 * Build the squash-merge commit message for a closed task.
 */
async function buildCloseCommitMessage(
  runtime: TeamAgentRuntime,
  baseBranch: string,
  task: Task,
): Promise<string> {
  const diff = await diffNameStatus(runtime.repoGit(), baseBranch, task.branchName!);
  const fileItems = diff.ok ? formatFileChanges(diff.value) : [];

  const attemptsNote = task.attempts > 1 ? ` (${task.attempts} attempts)` : "";
  const subject = `feat: ${task.title}${attemptsNote}`;

  const sections: CommitSection[] = [
    { heading: "Description", body: task.description },
  ];
  if (task.result) sections.push({ heading: "Worker result", body: task.result });
  sections.push({ heading: "Changes", items: fileItems });

  return composeCommitMessage(subject, sections);
}

// ---------------------------------------------------------------------------
// revise_task
// ---------------------------------------------------------------------------

async function handleRevise(runtime: TeamAgentRuntime, taskId: string, feedback: string) {
  const revised = await runtime.withQueueLock((queue) => {
    const result = reviseTask(queue, taskId, feedback, runtime.agentName);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });

  return {
    content: [{
      type: "text" as const,
      text: `Revision requested for '${revised.title}'. Worker notified with feedback. (attempt ${revised.attempts})`,
    }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// reject_task
// ---------------------------------------------------------------------------

async function handleReject(runtime: TeamAgentRuntime, taskId: string, feedback: string) {
  const snapshot = await runtime.loadQueue();
  const task = getTaskById(snapshot, taskId);
  const workerName = task?.assignedTo;

  if (workerName) await runtime.killWorkerWindow(workerName);

  if (task?.worktreePath && task.branchName) {
    await destroyWorkspace(runtime.repoGit(), {
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
  }

  const rejected = await runtime.withQueueLock((queue) => {
    const result = rejectTask(queue, taskId, feedback, runtime.agentName);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });

  return {
    content: [{
      type: "text" as const,
      text: `Rejected '${rejected.title}'. Worktree cleaned up. Requeued at top with feedback. (attempt ${rejected.attempts})`,
    }],
    details: {},
  };
}

