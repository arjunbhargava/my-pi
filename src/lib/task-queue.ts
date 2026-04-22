/**
 * Task queue file operations for multi-agent coordination.
 *
 * The queue is a single JSON file per team session. All mutations
 * use atomic writes (write-to-temp, then rename) to avoid corruption
 * when multiple agents write simultaneously. Last writer wins, which
 * is acceptable because the queue enforces strict state transitions.
 *
 * This is the only module that reads/writes the queue file directly.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type {
  ClosedTask,
  Result,
  Task,
  TaskQueue,
  TaskStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum log entries kept in the queue file. Oldest are trimmed. */
const MAX_LOG_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short random hex ID for tasks. */
export function generateTaskId(): string {
  return randomBytes(4).toString("hex");
}

/** Append a log entry and cap the log length. */
function appendLog(queue: TaskQueue, agent: string, action: string): void {
  queue.log.push({ timestamp: Date.now(), agent, action });
  if (queue.log.length > MAX_LOG_ENTRIES) {
    queue.log = queue.log.slice(-MAX_LOG_ENTRIES);
  }
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/** Read a queue file. Returns an error if the file doesn't exist or is malformed. */
export async function readQueue(queuePath: string): Promise<Result<TaskQueue>> {
  try {
    const raw = await readFile(queuePath, "utf-8");
    const parsed = JSON.parse(raw) as TaskQueue;
    return { ok: true, value: parsed };
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isNotFound) {
      return { ok: false, error: `Queue file not found: ${queuePath}` };
    }
    return {
      ok: false,
      error: `Failed to read queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Write a queue file atomically.
 * Writes to a temp file in the same directory, then renames into place.
 */
export async function writeQueue(
  queuePath: string,
  queue: TaskQueue,
): Promise<Result<void>> {
  const dir = path.dirname(queuePath);
  const tmpSuffix = randomBytes(4).toString("hex");
  const tmpPath = path.join(dir, `.team-tmp-${tmpSuffix}.json`);

  try {
    await mkdir(dir, { recursive: true });
    queue.updatedAt = Date.now();
    const json = JSON.stringify(queue, null, 2) + "\n";
    await writeFile(tmpPath, json, "utf-8");
    await rename(tmpPath, queuePath);
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Failed to write queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Queue creation
// ---------------------------------------------------------------------------

/** Create a fresh empty queue for a new team session. */
export function createQueue(teamId: string, goal: string, targetBranch: string): TaskQueue {
  const now = Date.now();
  return {
    teamId,
    goal,
    targetBranch,
    createdAt: now,
    updatedAt: now,
    tasks: [],
    closed: [],
    log: [{ timestamp: now, agent: "system", action: `Team created: ${goal}` }],
  };
}

// ---------------------------------------------------------------------------
// Task mutations
// ---------------------------------------------------------------------------

/**
 * Add a new task to the queue.
 * Appended to the end by default. Returns the created task.
 */
export function addTask(
  queue: TaskQueue,
  title: string,
  description: string,
  addedBy: string,
): Task {
  const now = Date.now();
  const task: Task = {
    id: generateTaskId(),
    title,
    description,
    status: "queued",
    addedBy,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  queue.tasks.push(task);
  appendLog(queue, addedBy, `Added task: ${title}`);
  return task;
}

/**
 * Dispatch a queued task to a worker.
 * Moves status from "queued" to "active" and increments attempts.
 */
export function dispatchTask(
  queue: TaskQueue,
  taskId: string,
  assignedTo: string,
  dispatchedBy: string,
  worktreeInfo?: { worktreePath: string; branchName: string },
): Result<Task> {
  const task = queue.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: `Task '${taskId}' not found` };
  if (task.status !== "queued") {
    return { ok: false, error: `Task '${taskId}' is '${task.status}', expected 'queued'` };
  }

  task.status = "active";
  task.assignedTo = assignedTo;
  task.attempts += 1;
  task.updatedAt = Date.now();
  if (worktreeInfo) {
    task.worktreePath = worktreeInfo.worktreePath;
    task.branchName = worktreeInfo.branchName;
  }
  appendLog(queue, dispatchedBy, `Dispatched '${task.title}' to ${assignedTo} (attempt ${task.attempts})`);
  return { ok: true, value: task };
}

/**
 * Mark an active task as ready for review.
 * The worker posts its result and the task moves to "review".
 */
export function completeTask(
  queue: TaskQueue,
  taskId: string,
  result: string,
  completedBy: string,
): Result<Task> {
  const task = queue.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: `Task '${taskId}' not found` };
  if (task.status !== "active") {
    return { ok: false, error: `Task '${taskId}' is '${task.status}', expected 'active'` };
  }

  task.status = "review";
  task.result = result;
  task.updatedAt = Date.now();
  appendLog(queue, completedBy, `Completed '${task.title}', ready for review`);
  return { ok: true, value: task };
}

/**
 * Close a task (evaluator approves).
 * Removes the task from the active array and archives a minimal summary.
 */
export function closeTask(
  queue: TaskQueue,
  taskId: string,
  closedBy: string,
): Result<ClosedTask> {
  const taskIndex = queue.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return { ok: false, error: `Task '${taskId}' not found` };

  const task = queue.tasks[taskIndex];
  if (task.status !== "review") {
    return { ok: false, error: `Task '${taskId}' is '${task.status}', expected 'review'` };
  }

  // Archive minimal summary
  const closed: ClosedTask = {
    id: task.id,
    title: task.title,
    closedBy,
    attempts: task.attempts,
    closedAt: Date.now(),
  };
  queue.closed.push(closed);

  // Remove from active tasks
  queue.tasks.splice(taskIndex, 1);
  appendLog(queue, closedBy, `Closed '${task.title}' after ${task.attempts} attempt(s)`);
  return { ok: true, value: closed };
}

/**
 * Reject a task (evaluator sends back with feedback).
 * Reinserts the task at position 0 with status "queued" and feedback preserved.
 * The previous result is kept so the next worker can see what was tried.
 */
export function rejectTask(
  queue: TaskQueue,
  taskId: string,
  feedback: string,
  rejectedBy: string,
): Result<Task> {
  const taskIndex = queue.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return { ok: false, error: `Task '${taskId}' not found` };

  const task = queue.tasks[taskIndex];
  if (task.status !== "review") {
    return { ok: false, error: `Task '${taskId}' is '${task.status}', expected 'review'` };
  }

  // Reset to queued, preserve result + attach feedback
  task.status = "queued";
  task.feedback = feedback;
  task.assignedTo = undefined;
  task.worktreePath = undefined;
  task.branchName = undefined;
  task.updatedAt = Date.now();

  // Move to top of queue
  queue.tasks.splice(taskIndex, 1);
  queue.tasks.unshift(task);
  appendLog(queue, rejectedBy, `Rejected '${task.title}': ${feedback.slice(0, 80)}`);
  return { ok: true, value: task };
}

/**
 * Recover a task whose worker died or hung.
 * Moves an "active" task back to "queued" at the top of the queue
 * with a note about why it was recovered. Does NOT increment attempts
 * since the work was never completed.
 */
export function recoverTask(
  queue: TaskQueue,
  taskId: string,
  reason: string,
  recoveredBy: string,
): Result<Task> {
  const taskIndex = queue.tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) return { ok: false, error: `Task '${taskId}' not found` };

  const task = queue.tasks[taskIndex];
  if (task.status !== "active") {
    return { ok: false, error: `Task '${taskId}' is '${task.status}', expected 'active'` };
  }

  task.status = "queued";
  task.feedback = reason;
  task.assignedTo = undefined;
  task.worktreePath = undefined;
  task.branchName = undefined;
  task.updatedAt = Date.now();

  // Move to top of queue
  queue.tasks.splice(taskIndex, 1);
  queue.tasks.unshift(task);
  appendLog(queue, recoveredBy, `Recovered '${task.title}': ${reason.slice(0, 80)}`);
  return { ok: true, value: task };
}

// ---------------------------------------------------------------------------
// Query helpers (for filtered reads — token-efficient)
// ---------------------------------------------------------------------------

/** Get all tasks with a given status. */
export function getTasksByStatus(queue: TaskQueue, status: TaskStatus): Task[] {
  return queue.tasks.filter((t) => t.status === status);
}

/** Get the next queued task (position 0 with status "queued"), if any. */
export function getNextQueuedTask(queue: TaskQueue): Task | null {
  return queue.tasks.find((t) => t.status === "queued") ?? null;
}

/** Get a task by ID. */
export function getTaskById(queue: TaskQueue, taskId: string): Task | null {
  return queue.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Build a compact status summary suitable for LLM context.
 * Avoids dumping full descriptions — just titles and statuses.
 */
export function getQueueSummary(queue: TaskQueue): string {
  const lines: string[] = [];
  lines.push(`Team: ${queue.goal}`);

  const queued = getTasksByStatus(queue, "queued");
  const active = getTasksByStatus(queue, "active");
  const review = getTasksByStatus(queue, "review");

  lines.push(`Queued: ${queued.length} | Active: ${active.length} | Review: ${review.length} | Closed: ${queue.closed.length}`);

  if (queued.length > 0) {
    lines.push("\nQueued:");
    for (const t of queued) {
      const feedbackNote = t.feedback ? " [rejected, has feedback]" : "";
      lines.push(`  ${t.id} — ${t.title}${feedbackNote}`);
    }
  }

  if (active.length > 0) {
    lines.push("\nActive:");
    for (const t of active) {
      lines.push(`  ${t.id} — ${t.title} → ${t.assignedTo ?? "?"} (attempt ${t.attempts})`);
    }
  }

  if (review.length > 0) {
    lines.push("\nReady for review:");
    for (const t of review) {
      lines.push(`  ${t.id} — ${t.title}`);
    }
  }

  return lines.join("\n");
}
