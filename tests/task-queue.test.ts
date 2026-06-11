/**
 * Unit tests for src/lib/task-queue.ts
 *
 * Tests queue CRUD operations, state transitions, and the rejection
 * requeue-at-top behavior. No pi dependency — pure library tests.
 *
 * Run: npx tsx tests/task-queue.test.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import {
  addTask,
  closeTask,
  completeTask,
  createQueue,
  dispatchTask,
  getNextQueuedTask,
  getDispatchableTasks,
  getQueueSummary,
  getTasksByStatus,
  readQueue,
  recoverTask,
  rejectTask,
  reviseTask,
  writeQueue,
} from "../src/lib/task-queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "task-queue-test-"));
  return path.join(tmpDir, "queue.json");
}

async function cleanup(): Promise<void> {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("createQueue produces valid empty queue", async () => {
  const q = createQueue("team-1", "Build auth", "main", "pi-team-test");
  assert.equal(q.teamId, "team-1");
  assert.equal(q.goal, "Build auth");
  assert.equal(q.tasks.length, 0);
  assert.equal(q.closed.length, 0);
  assert.ok(q.log.length > 0, "should have initial log entry");
});

test("write and read roundtrip", async () => {
  const queuePath = await setup();
  const q = createQueue("team-2", "Test roundtrip", "main", "pi-team-test");
  addTask(q, "First task", "Do something", "orchestrator");

  const writeResult = await writeQueue(queuePath, q);
  assert.ok(writeResult.ok);

  const readResult = await readQueue(queuePath);
  assert.ok(readResult.ok);
  if (!readResult.ok) return;

  assert.equal(readResult.value.teamId, "team-2");
  assert.equal(readResult.value.tasks.length, 1);
  assert.equal(readResult.value.tasks[0].title, "First task");
  await cleanup();
});

test("read nonexistent file returns error", async () => {
  const result = await readQueue("/nonexistent/path/queue.json");
  assert.ok(!result.ok);
});

test("addTask appends to end", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  addTask(q, "Task A", "desc", "orch");
  addTask(q, "Task B", "desc", "orch");
  addTask(q, "Task C", "desc", "orch");

  assert.equal(q.tasks.length, 3);
  assert.equal(q.tasks[0].title, "Task A");
  assert.equal(q.tasks[2].title, "Task C");
  assert.equal(q.tasks[0].status, "queued");
});

test("dispatchTask transitions queued → active", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Implement", "do it", "orch");

  const result = dispatchTask(q, task.id, "worker-1", "orch");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.status, "active");
  assert.equal(result.value.assignedTo, "worker-1");
  assert.equal(result.value.attempts, 1);
});

test("dispatchTask rejects non-queued task", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Implement", "do it", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");

  // Try to dispatch again — already active
  const result = dispatchTask(q, task.id, "worker-2", "orch");
  assert.ok(!result.ok);
});

test("completeTask transitions active → review", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Implement", "do it", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");

  const result = completeTask(q, task.id, "Added auth.ts", "worker-1");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.status, "review");
  assert.equal(result.value.result, "Added auth.ts");
});

test("closeTask archives and removes from active tasks", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Implement", "do it", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "Done", "worker-1");

  const result = closeTask(q, task.id, "evaluator");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(q.tasks.length, 0, "task removed from active array");
  assert.equal(q.closed.length, 1, "task archived");
  assert.equal(q.closed[0].title, "Implement");
  assert.equal(q.closed[0].closedBy, "evaluator");
});

test("rejectTask requeues at top with feedback", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  addTask(q, "Task A", "first", "orch");
  const taskB = addTask(q, "Task B", "second", "orch");
  addTask(q, "Task C", "third", "orch");

  // Dispatch and complete B
  dispatchTask(q, taskB.id, "worker-1", "orch");
  completeTask(q, taskB.id, "Result B", "worker-1");

  // Reject B
  const result = rejectTask(q, taskB.id, "Missing error handling", "evaluator");
  assert.ok(result.ok);
  if (!result.ok) return;

  // B should be at top, status queued, feedback preserved, result preserved
  assert.equal(q.tasks[0].id, taskB.id, "rejected task at position 0");
  assert.equal(q.tasks[0].status, "queued");
  assert.equal(q.tasks[0].feedback, "Missing error handling");
  assert.equal(q.tasks[0].result, "Result B", "previous result kept");
  assert.equal(q.tasks[0].assignedTo, undefined, "assignedTo cleared");
});

test("rejectTask preserves attempt count", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Tricky task", "desc", "orch");

  // First attempt
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "Attempt 1", "worker-1");
  rejectTask(q, task.id, "Wrong approach", "eval");

  assert.equal(q.tasks[0].attempts, 1);

  // Second attempt
  dispatchTask(q, task.id, "worker-2", "orch");
  completeTask(q, task.id, "Attempt 2", "worker-2");
  rejectTask(q, task.id, "Still wrong", "eval");

  assert.equal(q.tasks[0].attempts, 2);
});

test("getNextQueuedTask returns first queued task", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  addTask(q, "B", "desc", "orch");
  dispatchTask(q, taskA.id, "worker-1", "orch"); // A is now active

  const next = getNextQueuedTask(q);
  assert.ok(next);
  assert.equal(next!.title, "B");
});

test("getTasksByStatus filters correctly", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const t1 = addTask(q, "A", "d", "o");
  addTask(q, "B", "d", "o");
  addTask(q, "C", "d", "o");
  dispatchTask(q, t1.id, "w1", "o");

  assert.equal(getTasksByStatus(q, "queued").length, 2);
  assert.equal(getTasksByStatus(q, "active").length, 1);
  assert.equal(getTasksByStatus(q, "review").length, 0);
});

test("getQueueSummary produces readable output", async () => {
  const q = createQueue("t", "Build auth", "main", "pi-team-test");
  addTask(q, "Implement JWT", "desc", "orch");
  const t2 = addTask(q, "Write tests", "desc", "orch");
  dispatchTask(q, t2.id, "worker-1", "orch");

  const summary = getQueueSummary(q);
  assert.ok(summary.includes("Build auth"));
  assert.ok(summary.includes("Queued: 1"));
  assert.ok(summary.includes("Active: 1"));
  assert.ok(summary.includes("Implement JWT"));
  assert.ok(summary.includes("worker-1"));
});

test("recoverTask moves active task back to queued without incrementing attempts", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Fragile task", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");

  assert.equal(task.attempts, 1);
  assert.equal(task.status, "active");

  const result = recoverTask(q, task.id, "Worker window died", "orchestrator");
  assert.ok(result.ok);
  if (!result.ok) return;

  // Should be back at top of queue, same attempt count
  assert.equal(q.tasks[0].id, task.id);
  assert.equal(q.tasks[0].status, "queued");
  assert.equal(q.tasks[0].attempts, 1, "attempts should NOT increment on recovery");
  assert.equal(q.tasks[0].feedback, "Worker window died");
  assert.equal(q.tasks[0].assignedTo, undefined);
});

test("recoverTask rejects non-active task", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Not active", "desc", "orch");

  const result = recoverTask(q, task.id, "reason", "orch");
  assert.ok(!result.ok);
});

test("log is capped at limit", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  // Add 60 tasks — each addTask appends a log entry
  for (let i = 0; i < 60; i++) {
    addTask(q, `Task ${i}`, "d", "o");
  }
  // Log should be capped (50 entries max + initial entry)
  assert.ok(q.log.length <= 51, `log length ${q.log.length} exceeds cap`);
});

// ---------------------------------------------------------------------------
// reviseTask tests
// ---------------------------------------------------------------------------

test("reviseTask transitions review → active with feedback, preserving worker", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Implement auth", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch", {
    worktreePath: "/tmp/wt",
    branchName: "team/t/worker-1",
  });
  completeTask(q, task.id, "Done", "worker-1");

  const result = reviseTask(q, task.id, "Add a test for empty input", "evaluator");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.status, "active");
  assert.equal(result.value.feedback, "Add a test for empty input");
  // Worker identity and worktree are preserved
  assert.equal(result.value.assignedTo, "worker-1");
  assert.equal(result.value.worktreePath, "/tmp/wt");
  assert.equal(result.value.branchName, "team/t/worker-1");
});

test("reviseTask rejects non-review task", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Task", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");

  // Task is active, not in review
  const result = reviseTask(q, task.id, "feedback", "evaluator");
  assert.ok(!result.ok);
});

test("reviseTask does not increment attempts", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Task", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "Result", "worker-1");

  assert.equal(task.attempts, 1);
  reviseTask(q, task.id, "fix typo", "evaluator");
  assert.equal(task.attempts, 1, "attempts should not increment on revision");
});

// ---------------------------------------------------------------------------
// dependsOn tests
// ---------------------------------------------------------------------------

test("addTask with dependsOn stores dependencies", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  const taskB = addTask(q, "B", "depends on A", "orch", { dependsOn: [taskA.id] });

  assert.deepEqual(taskB.dependsOn, [taskA.id]);
});

test("dispatchTask refuses when dependencies are unmet", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  const taskB = addTask(q, "B", "depends on A", "orch", { dependsOn: [taskA.id] });

  // A is still queued (not closed) — dispatching B should fail
  const result = dispatchTask(q, taskB.id, "worker-1", "orch");
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.ok(result.error.includes("unmet dependencies"));
});

test("dispatchTask succeeds when all dependencies are closed", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  const taskB = addTask(q, "B", "depends on A", "orch", { dependsOn: [taskA.id] });

  // Close task A through the full lifecycle
  dispatchTask(q, taskA.id, "worker-1", "orch");
  completeTask(q, taskA.id, "Done", "worker-1");
  closeTask(q, taskA.id, "evaluator");

  // Now B should be dispatchable
  const result = dispatchTask(q, taskB.id, "worker-2", "orch");
  assert.ok(result.ok);
});

test("dispatchTask with no dependsOn always succeeds", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const task = addTask(q, "Independent", "desc", "orch");

  const result = dispatchTask(q, task.id, "worker-1", "orch");
  assert.ok(result.ok);
});

// ---------------------------------------------------------------------------
// getDispatchableTasks tests
// ---------------------------------------------------------------------------

test("getDispatchableTasks returns queued tasks without dependencies", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  const taskB = addTask(q, "B", "desc", "orch");
  dispatchTask(q, taskA.id, "worker-1", "orch");

  const dispatchable = getDispatchableTasks(q);
  assert.deepEqual(dispatchable.map((t) => t.id), [taskB.id]);
});

test("getDispatchableTasks excludes tasks with unmet dependencies", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  const taskA = addTask(q, "A", "desc", "orch");
  const taskB = addTask(q, "B", "depends on A", "orch", { dependsOn: [taskA.id] });

  const dispatchable = getDispatchableTasks(q);
  assert.deepEqual(dispatchable.map((t) => t.id), [taskA.id]);

  // Close A through the full lifecycle — B becomes dispatchable.
  dispatchTask(q, taskA.id, "worker-1", "orch");
  completeTask(q, taskA.id, "Done", "worker-1");
  closeTask(q, taskA.id, "evaluator");

  assert.deepEqual(getDispatchableTasks(q).map((t) => t.id), [taskB.id]);
});

test("getDispatchableTasks returns empty for a drained queue", async () => {
  const q = createQueue("t", "g", "main", "pi-team-test");
  assert.deepEqual(getDispatchableTasks(q), []);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
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

console.log("task-queue tests:\n");
run();
