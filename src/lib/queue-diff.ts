/**
 * Pure-logic module for detecting what changed between two queue snapshots.
 *
 * No I/O, no side effects — takes two TaskQueue values and returns a list
 * of events describing every state transition that occurred between them.
 */

import type { ClosedTask, Task, TaskQueue, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminated set of transitions the queue monitor can observe. */
export type QueueEventType =
  | "task_added"       // new task appeared (status: queued)
  | "task_dispatched"  // queued → active
  | "task_completed"   // active → review
  | "task_closed"      // removed from tasks[], archived in closed[]
  | "task_rejected"    // review → queued (has feedback)
  | "task_recovered";  // active → queued (worker died)

/**
 * A single observed change between two queue snapshots.
 *
 * `task` carries full task data for all events except `task_closed`.
 * `closedTask` carries the archived summary for `task_closed` events.
 */
export interface QueueEvent {
  type: QueueEventType;
  taskId: string;
  title: string;
  /** Full task data at the time of the event. Undefined for task_closed. */
  task?: Task;
  /** Present only for task_closed events. */
  closedTask?: ClosedTask;
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Diff two queue snapshots and return all events that describe the change.
 *
 * When `prev` is null (first load), emits `task_added` for every live task
 * and `task_closed` for every entry already in `closed`.
 */
export function diffQueues(prev: TaskQueue | null, next: TaskQueue): QueueEvent[] {
  if (prev === null) {
    return buildInitialEvents(next);
  }
  return buildDiffEvents(prev, next);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildInitialEvents(queue: TaskQueue): QueueEvent[] {
  const events: QueueEvent[] = [];

  for (const task of queue.tasks) {
    events.push({ type: "task_added", taskId: task.id, title: task.title, task });
  }

  for (const closedTask of queue.closed) {
    events.push({ type: "task_closed", taskId: closedTask.id, title: closedTask.title, closedTask });
  }

  return events;
}

function buildDiffEvents(prev: TaskQueue, next: TaskQueue): QueueEvent[] {
  const events: QueueEvent[] = [];

  const prevById = new Map<string, Task>(prev.tasks.map((t) => [t.id, t]));
  const nextById = new Map<string, Task>(next.tasks.map((t) => [t.id, t]));
  const nextClosedById = new Map<string, ClosedTask>(next.closed.map((c) => [c.id, c]));

  for (const [id, task] of nextById) {
    if (!prevById.has(id)) {
      events.push({ type: "task_added", taskId: id, title: task.title, task });
    }
  }

  for (const [id, prevTask] of prevById) {
    const nextTask = nextById.get(id);

    if (nextTask === undefined) {
      const closedTask = nextClosedById.get(id);
      if (closedTask !== undefined) {
        events.push({ type: "task_closed", taskId: id, title: closedTask.title, closedTask });
      }
      continue;
    }

    if (prevTask.status === nextTask.status) continue;

    const event = eventForTransition(prevTask.status, nextTask.status, nextTask);
    if (event !== null) events.push(event);
  }

  return events;
}

function eventForTransition(
  from: TaskStatus,
  to: TaskStatus,
  task: Task,
): QueueEvent | null {
  const base = { taskId: task.id, title: task.title, task };

  if (from === "queued" && to === "active")  return { type: "task_dispatched", ...base };
  if (from === "active" && to === "review")  return { type: "task_completed",  ...base };
  if (from === "review" && to === "queued")  return { type: "task_rejected",   ...base };
  if (from === "active" && to === "queued")  return { type: "task_recovered",  ...base };

  return null;
}
