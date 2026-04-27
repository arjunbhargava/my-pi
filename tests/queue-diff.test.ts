/**
 * Unit tests for src/lib/queue-diff.ts
 *
 * Covers all nine detection scenarios: initial snapshot, no change, each
 * status transition, simultaneous events, and new-task-between-snapshots.
 *
 * Run: npx tsx tests/queue-diff.test.ts
 */

import { strict as assert } from "node:assert";

import {
  addTask,
  closeTask,
  completeTask,
  createQueue,
  dispatchTask,
  recoverTask,
  rejectTask,
} from "../src/lib/task-queue.js";
import { diffQueues } from "../src/lib/queue-diff.js";
import type { TaskQueue } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep clone a queue so mutations to the copy don't affect the original. */
function clone(q: TaskQueue): TaskQueue {
  return JSON.parse(JSON.stringify(q)) as TaskQueue;
}

function freshQueue(): TaskQueue {
  return createQueue("team-test", "Test goal", "main", "pi-team-test");
}

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => void }> = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("initial snapshot: emits task_added for every task in queue", () => {
  const q = freshQueue();
  addTask(q, "Alpha", "desc", "orch");
  addTask(q, "Beta", "desc", "orch");

  const events = diffQueues(null, q);

  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.type === "task_added"));
  assert.ok(events.some((e) => e.title === "Alpha"));
  assert.ok(events.some((e) => e.title === "Beta"));
});

test("initial snapshot: emits task_closed for each entry in closed[]", () => {
  const q = freshQueue();
  const task = addTask(q, "Done task", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "result", "worker-1");
  closeTask(q, task.id, "eval");

  const events = diffQueues(null, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_closed");
  assert.equal(events[0].title, "Done task");
  assert.ok(events[0].closedTask !== undefined);
  assert.equal(events[0].task, undefined);
});

test("no change: identical prev and next returns empty array", () => {
  const q = freshQueue();
  addTask(q, "Steady task", "desc", "orch");

  const prev = clone(q);
  const events = diffQueues(prev, q);

  assert.equal(events.length, 0);
});

test("single dispatch: queued→active emits task_dispatched with task data", () => {
  const q = freshQueue();
  const task = addTask(q, "Ship it", "desc", "orch");
  const prev = clone(q);

  dispatchTask(q, task.id, "worker-1", "orch");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_dispatched");
  assert.equal(events[0].taskId, task.id);
  assert.equal(events[0].title, "Ship it");
  assert.ok(events[0].task !== undefined);
  assert.equal(events[0].task!.status, "active");
  assert.equal(events[0].task!.assignedTo, "worker-1");
});

test("single completion: active→review emits task_completed", () => {
  const q = freshQueue();
  const task = addTask(q, "Write tests", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  const prev = clone(q);

  completeTask(q, task.id, "All tests pass", "worker-1");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_completed");
  assert.equal(events[0].taskId, task.id);
  assert.ok(events[0].task !== undefined);
  assert.equal(events[0].task!.status, "review");
});

test("single close: task removed + in closed[] emits task_closed with closedTask", () => {
  const q = freshQueue();
  const task = addTask(q, "Merge PR", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "merged", "worker-1");
  const prev = clone(q);

  closeTask(q, task.id, "evaluator");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_closed");
  assert.equal(events[0].taskId, task.id);
  assert.equal(events[0].title, "Merge PR");
  assert.ok(events[0].closedTask !== undefined);
  assert.equal(events[0].closedTask!.closedBy, "evaluator");
  assert.equal(events[0].task, undefined);
});

test("rejection: review→queued emits task_rejected", () => {
  const q = freshQueue();
  const task = addTask(q, "Add auth", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "Did something", "worker-1");
  const prev = clone(q);

  rejectTask(q, task.id, "Missing error handling", "evaluator");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_rejected");
  assert.equal(events[0].taskId, task.id);
  assert.ok(events[0].task !== undefined);
  assert.equal(events[0].task!.status, "queued");
  assert.equal(events[0].task!.feedback, "Missing error handling");
});

test("recovery: active→queued emits task_recovered", () => {
  const q = freshQueue();
  const task = addTask(q, "Risky work", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  const prev = clone(q);

  recoverTask(q, task.id, "Worker window died", "orchestrator");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_recovered");
  assert.equal(events[0].taskId, task.id);
  assert.ok(events[0].task !== undefined);
  assert.equal(events[0].task!.status, "queued");
});

test("multiple simultaneous: dispatch + complete + add in same diff emits all events", () => {
  const q = freshQueue();
  const taskA = addTask(q, "Task A", "desc", "orch");
  const taskB = addTask(q, "Task B", "desc", "orch");
  dispatchTask(q, taskB.id, "worker-2", "orch"); // taskB is active
  const prev = clone(q); // prev: taskA=queued, taskB=active

  // In the same diff interval: dispatch A, complete B, add C
  dispatchTask(q, taskA.id, "worker-1", "orch");
  completeTask(q, taskB.id, "B done", "worker-2");
  addTask(q, "Task C", "desc", "orch");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 3);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("task_dispatched"), "should include task_dispatched for A");
  assert.ok(types.includes("task_completed"), "should include task_completed for B");
  assert.ok(types.includes("task_added"), "should include task_added for C");
});

test("new task between snapshots: ID in next but not prev emits task_added", () => {
  const q = freshQueue();
  addTask(q, "Existing task", "desc", "orch");
  const prev = clone(q);

  addTask(q, "Brand new task", "desc", "orch");

  const events = diffQueues(prev, q);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task_added");
  assert.equal(events[0].title, "Brand new task");
  assert.ok(events[0].task !== undefined);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("queue-diff tests:\n");
run();
