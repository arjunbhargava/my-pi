/**
 * Unit tests for processEvents routing logic in scripts/team-slack-bridge.ts.
 *
 * Verifies which events go to which Slack threads, what blocks get posted,
 * and that ThreadState is mutated correctly — without any real Slack calls.
 *
 * Run: npx tsx tests/bridge-events.test.ts
 */

import { strict as assert } from "node:assert";

import { processEvents } from "../src/lib/bridge-events.js";
import {
  addTask,
  closeTask,
  completeTask,
  createQueue,
  dispatchTask,
  rejectTask,
  recoverTask,
} from "../src/lib/task-queue.js";
import { createThreadState } from "../src/lib/slack-threads.js";
import {
  formatQueueEvent,
  formatWorkerThreadHeader,
  formatCodeDiff,
} from "../src/lib/slack-format.js";
import { diffQueues } from "../src/lib/queue-diff.js";
import type { TaskQueue } from "../src/lib/types.js";
import type { ThreadState } from "../src/lib/slack-threads.js";
import type { SlackBlock } from "../src/lib/slack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PostCall {
  blocks: SlackBlock[];
  text: string;
  threadTs: string | undefined;
}

function makePostFn(returnTs = "posted-ts"): { calls: PostCall[]; post: (blocks: SlackBlock[], text: string, threadTs?: string) => Promise<string | null> } {
  const calls: PostCall[] = [];
  let counter = 0;
  const post = async (blocks: SlackBlock[], text: string, threadTs?: string): Promise<string | null> => {
    calls.push({ blocks, text, threadTs });
    return `${returnTs}-${++counter}`;
  };
  return { calls, post };
}

function noopDiffFn(_repoDir: string, _targetBranch: string, _branchName: string): Promise<string> {
  return Promise.resolve("");
}

function clone(q: TaskQueue): TaskQueue {
  return JSON.parse(JSON.stringify(q)) as TaskQueue;
}

function freshQueue(): TaskQueue {
  return createQueue("team-test", "Test goal", "main", "pi-team-test");
}

function freshState(): ThreadState {
  return createThreadState("team-test", "C0TEST");
}

// ---------------------------------------------------------------------------
// Test registration
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("task_dispatched: posts formatWorkerThreadHeader blocks as top-level message, stores ts in taskThreads", async () => {
  const q = freshQueue();
  const task = addTask(q, "Implement feature", "Full description", "orch");
  const prev = clone(q);
  dispatchTask(q, task.id, "worker-1", "orch");
  const dispatchedTask = q.tasks.find((t) => t.id === task.id)!;

  const state = freshState();
  const { calls, post } = makePostFn("dispatch-ts");

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, undefined);
  assert.deepEqual(calls[0].blocks, formatWorkerThreadHeader(dispatchedTask));
  assert.equal(state.taskThreads[task.id], "dispatch-ts-1");
});

test("task_completed: posts event + diff blocks as thread reply, sets lastPostedTs", async () => {
  const q = freshQueue();
  const task = addTask(q, "Write tests", "Full description", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  const prev = clone(q);
  completeTask(q, task.id, "Tests pass", "worker-1");
  const completedTask = q.tasks.find((t) => t.id === task.id)!;
  completedTask.branchName = "team/abc/worker-1";

  const state = freshState();
  state.taskThreads[task.id] = "existing-thread-ts";

  const fakeDiff = "diff --git a/foo +added line";
  const diffFn = async (): Promise<string> => fakeDiff;
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_completed")!;
  const expectedBlocks = [...formatQueueEvent(event), ...formatCodeDiff(fakeDiff)];

  await processEvents(q, prev, state, post, "/repo", diffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, "existing-thread-ts");
  assert.deepEqual(calls[0].blocks, expectedBlocks);
  assert.equal(state.lastPostedTs[task.id], "existing-thread-ts");
});

test("task_completed with no branchName: posts only event blocks (no diff)", async () => {
  const q = freshQueue();
  const task = addTask(q, "No branch task", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  const prev = clone(q);
  completeTask(q, task.id, "Done", "worker-1");
  // branchName left undefined

  const state = freshState();
  state.taskThreads[task.id] = "thread-ts";
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_completed")!;
  const expectedBlocks = formatQueueEvent(event); // no diff blocks appended

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].blocks, expectedBlocks);
});

test("task_closed: posts event blocks as reply in worker thread", async () => {
  const q = freshQueue();
  const task = addTask(q, "Merge PR", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "merged", "worker-1");
  const prev = clone(q);
  closeTask(q, task.id, "evaluator");

  const state = freshState();
  state.taskThreads[task.id] = "worker-thread-ts";
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_closed")!;

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, "worker-thread-ts");
  assert.deepEqual(calls[0].blocks, formatQueueEvent(event));
});

test("task_rejected: posts event blocks as reply in worker thread", async () => {
  const q = freshQueue();
  const task = addTask(q, "Add auth", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  completeTask(q, task.id, "Did something", "worker-1");
  const prev = clone(q);
  rejectTask(q, task.id, "Missing error handling", "evaluator");

  const state = freshState();
  state.taskThreads[task.id] = "worker-thread-ts";
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_rejected")!;

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, "worker-thread-ts");
  assert.deepEqual(calls[0].blocks, formatQueueEvent(event));
});

test("task_recovered: posts event blocks as reply in worker thread", async () => {
  const q = freshQueue();
  const task = addTask(q, "Risky work", "desc", "orch");
  dispatchTask(q, task.id, "worker-1", "orch");
  const prev = clone(q);
  recoverTask(q, task.id, "Worker died", "orchestrator");

  const state = freshState();
  state.taskThreads[task.id] = "worker-thread-ts";
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_recovered")!;

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, "worker-thread-ts");
  assert.deepEqual(calls[0].blocks, formatQueueEvent(event));
});

test("task_added: posts event blocks as reply in team thread", async () => {
  const q = freshQueue();
  const prev = clone(q);
  addTask(q, "Brand new task", "desc", "orchestrator");

  const state = freshState();
  state.teamMessageTs = "team-top-level-ts";
  const { calls, post } = makePostFn();

  const event = diffQueues(prev, q).find((e) => e.type === "task_added")!;

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, "team-top-level-ts");
  assert.deepEqual(calls[0].blocks, formatQueueEvent(event));
});

test("task_added with no teamMessageTs: posts event blocks as top-level message", async () => {
  const q = freshQueue();
  const prev = clone(q);
  addTask(q, "New task no thread", "desc", "orchestrator");

  const state = freshState();
  // teamMessageTs intentionally left null
  const { calls, post } = makePostFn();

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, undefined);
});

test("multiple events in one diff: all routed correctly, state mutations cumulative", async () => {
  const q = freshQueue();
  const taskA = addTask(q, "Task A", "desc", "orch");
  const taskB = addTask(q, "Task B", "desc", "orch");
  dispatchTask(q, taskB.id, "worker-2", "orch");
  const prev = clone(q);

  // taskA: queued → active (task_dispatched)
  dispatchTask(q, taskA.id, "worker-1", "orch");
  // taskB: active → review (task_completed)
  completeTask(q, taskB.id, "B result", "worker-2");
  // taskC: newly added (task_added)
  const taskC = addTask(q, "Task C", "desc", "orch");

  const state = freshState();
  state.teamMessageTs = "team-ts";
  state.taskThreads[taskB.id] = "thread-B";

  let postCounter = 0;
  const calls: PostCall[] = [];
  const post = async (blocks: SlackBlock[], text: string, threadTs?: string): Promise<string | null> => {
    calls.push({ blocks, text, threadTs });
    return `ts-${++postCounter}`;
  };

  await processEvents(q, prev, state, post, "/repo", noopDiffFn);

  assert.equal(calls.length, 3);

  // task_dispatched for taskA: top-level, header blocks, ts stored
  const dispatchedTaskA = q.tasks.find((t) => t.id === taskA.id)!;
  const dispatchCall = calls.find((c) => c.threadTs === undefined && c.blocks[0].type === "header");
  assert.ok(dispatchCall !== undefined, "expected a top-level header post for task_dispatched");
  assert.deepEqual(dispatchCall.blocks, formatWorkerThreadHeader(dispatchedTaskA));
  assert.ok(state.taskThreads[taskA.id] !== undefined, "taskA thread ts should be stored");

  // task_completed for taskB: reply in thread-B
  const completedCall = calls.find((c) => c.threadTs === "thread-B");
  assert.ok(completedCall !== undefined, "expected a reply in thread-B for task_completed");
  assert.equal(state.lastPostedTs[taskB.id], "thread-B");

  // task_added for taskC: reply in team thread
  const addedCall = calls.find((c) => c.threadTs === "team-ts");
  assert.ok(addedCall !== undefined, "expected a reply in team thread for task_added");
  const addedEvent = diffQueues(prev, q).find((e) => e.type === "task_added" && e.taskId === taskC.id)!;
  assert.deepEqual(addedCall.blocks, formatQueueEvent(addedEvent));
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

console.log("bridge-events tests:\n");
void run();
