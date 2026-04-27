/**
 * Unit tests for src/lib/slack-format.ts
 *
 * Covers formatQueueEvent (all 6 event types + truncation), formatTeamSummary,
 * formatCodeDiff (short, truncated, empty), and formatWorkerThreadHeader.
 *
 * Run: npx tsx tests/slack-format.test.ts
 */

import { strict as assert } from "node:assert";

import {
  formatQueueEvent,
  formatTeamSummary,
  formatCodeDiff,
  formatWorkerThreadHeader,
} from "../src/lib/slack-format.js";
import type { QueueEvent } from "../src/lib/queue-diff.js";
import type { Task, TaskQueue, ClosedTask } from "../src/lib/types.js";
import type { SectionBlock, ContextBlock, HeaderBlock, MrkdwnText } from "../src/lib/slack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "abc123",
    title: "Test task",
    description: "A test description",
    status: "queued",
    addedBy: "orchestrator",
    attempts: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function sectionText(block: { type: string; text?: unknown }): string {
  return (block as SectionBlock).text.text;
}

function headerText(block: { type: string; text?: unknown }): string {
  return (block as HeaderBlock).text.text;
}

function contextText(block: { type: string; elements?: unknown }): string {
  const elem = (block as ContextBlock).elements[0] as MrkdwnText;
  return elem.text;
}

// ---------------------------------------------------------------------------
// Test registration
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void }> = [];

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("formatQueueEvent: all 6 event types produce correct emoji and block structure", () => {
  const task = makeTask({ assignedTo: "worker-1", attempts: 2, result: "done", feedback: "fix it" });

  // task_added
  const added: QueueEvent = { type: "task_added", taskId: "abc123", title: "New task", task };
  const addedBlocks = formatQueueEvent(added);
  assert.equal(addedBlocks.length, 2);
  assert.equal(addedBlocks[0].type, "section");
  assert.ok(sectionText(addedBlocks[0]).startsWith("📋"));
  assert.ok(sectionText(addedBlocks[0]).includes("New task"));
  assert.equal(addedBlocks[1].type, "context");

  // task_dispatched
  const dispatched: QueueEvent = { type: "task_dispatched", taskId: "abc123", title: "Dispatched task", task };
  const dispatchedBlocks = formatQueueEvent(dispatched);
  assert.equal(dispatchedBlocks.length, 1);
  assert.equal(dispatchedBlocks[0].type, "section");
  const dispatchText = sectionText(dispatchedBlocks[0]);
  assert.ok(dispatchText.startsWith("⚡"));
  assert.ok(dispatchText.includes("Dispatched task"));
  assert.ok(dispatchText.includes("`worker-1`"));
  assert.ok(dispatchText.includes("attempt 2"));

  // task_completed
  const completed: QueueEvent = { type: "task_completed", taskId: "abc123", title: "Completed task", task };
  const completedBlocks = formatQueueEvent(completed);
  assert.equal(completedBlocks.length, 2);
  assert.equal(completedBlocks[0].type, "section");
  assert.ok(sectionText(completedBlocks[0]).startsWith("✅"));
  assert.ok(sectionText(completedBlocks[0]).includes("Completed task"));
  assert.equal(completedBlocks[1].type, "context");

  // task_closed
  const closedTask: ClosedTask = { id: "abc123", title: "Closed task", closedBy: "evaluator", attempts: 3, closedAt: 2000 };
  const closed: QueueEvent = { type: "task_closed", taskId: "abc123", title: "Closed task", closedTask };
  const closedBlocks = formatQueueEvent(closed);
  assert.equal(closedBlocks.length, 1);
  assert.equal(closedBlocks[0].type, "section");
  const closedText = sectionText(closedBlocks[0]);
  assert.ok(closedText.startsWith("🎉"));
  assert.ok(closedText.includes("Closed task"));
  assert.ok(closedText.includes("3 attempt(s)"));

  // task_rejected
  const rejected: QueueEvent = { type: "task_rejected", taskId: "abc123", title: "Rejected task", task };
  const rejectedBlocks = formatQueueEvent(rejected);
  assert.equal(rejectedBlocks.length, 2);
  assert.equal(rejectedBlocks[0].type, "section");
  assert.ok(sectionText(rejectedBlocks[0]).startsWith("🔄"));
  assert.ok(sectionText(rejectedBlocks[0]).includes("Rejected task"));
  assert.equal(rejectedBlocks[1].type, "context");

  // task_recovered
  const recovered: QueueEvent = { type: "task_recovered", taskId: "abc123", title: "Recovered task", task };
  const recoveredBlocks = formatQueueEvent(recovered);
  assert.equal(recoveredBlocks.length, 1);
  assert.equal(recoveredBlocks[0].type, "section");
  const recoveredText = sectionText(recoveredBlocks[0]);
  assert.ok(recoveredText.startsWith("⚠️"));
  assert.ok(recoveredText.includes("Recovered task"));
  assert.ok(recoveredText.includes("requeued"));
});

test("formatQueueEvent: task_completed with long result truncates context to 200 chars + ellipsis", () => {
  const longResult = "x".repeat(250);
  const task = makeTask({ result: longResult });
  const event: QueueEvent = { type: "task_completed", taskId: "abc123", title: "Big task", task };

  const blocks = formatQueueEvent(event);

  assert.equal(blocks.length, 2);
  const ctx = contextText(blocks[1]);
  assert.equal(ctx.length, 203); // 200 chars + "..."
  assert.ok(ctx.endsWith("..."));
  assert.ok(!ctx.includes("x".repeat(201)));
});

test("formatTeamSummary: mixed-status queue produces correct header, counts, and queued list", () => {
  const queue: TaskQueue = {
    teamId: "team-123",
    goal: "Build something great",
    targetBranch: "main",
    tmuxSession: "pi-team-123",
    createdAt: 1000,
    updatedAt: 1000,
    tasks: [
      makeTask({ id: "t1", status: "queued", title: "Alpha" }),
      makeTask({ id: "t2", status: "queued", title: "Beta" }),
      makeTask({ id: "t3", status: "active", title: "Gamma" }),
      makeTask({ id: "t4", status: "review", title: "Delta" }),
    ],
    closed: [
      { id: "t5", title: "Epsilon", closedBy: "evaluator", attempts: 1, closedAt: 1000 },
    ],
    log: [],
  };

  const blocks = formatTeamSummary(queue);

  assert.ok(blocks.length >= 3);
  assert.equal(blocks[0].type, "header");
  assert.ok(headerText(blocks[0]).includes("🏁 Team:"));
  assert.ok(headerText(blocks[0]).includes("Build something great"));

  assert.equal(blocks[1].type, "section");
  const countText = sectionText(blocks[1]);
  assert.ok(countText.includes("2 queued"));
  assert.ok(countText.includes("1 active"));
  assert.ok(countText.includes("1 in review"));
  assert.ok(countText.includes("1 closed"));

  assert.equal(blocks[2].type, "section");
  const listText = sectionText(blocks[2]);
  assert.ok(listText.includes("Alpha"));
  assert.ok(listText.includes("Beta"));
  assert.ok(!listText.includes("Gamma")); // active, not queued
});

test("formatCodeDiff: short diff is wrapped in triple backticks", () => {
  const diff = "diff --git a/foo b/foo\n+added line\n-removed line";
  const blocks = formatCodeDiff(diff);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "section");
  const text = sectionText(blocks[0]);
  assert.ok(text.startsWith("```\n"));
  assert.ok(text.endsWith("\n```"));
  assert.ok(text.includes("added line"));
  assert.ok(text.includes("removed line"));
});

test("formatCodeDiff: diff exceeding 2900 chars is truncated with note", () => {
  const diff = "a".repeat(3000);
  const blocks = formatCodeDiff(diff);

  assert.equal(blocks.length, 1);
  const text = sectionText(blocks[0]);
  assert.ok(text.includes("(truncated, 3000 chars total)"));
  // The full 3000-char diff must not appear intact
  assert.ok(!text.includes("a".repeat(2901)));
});

test("formatCodeDiff: empty diff returns _No changes_ block", () => {
  const blocks = formatCodeDiff("");

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "section");
  assert.equal(sectionText(blocks[0]), "_No changes_");
});

test("formatWorkerThreadHeader: header, description, and context are correct", () => {
  const task = makeTask({
    id: "xyz789",
    title: "Implement auth",
    description: "Add JWT middleware to all protected routes",
    assignedTo: "worker-2",
    attempts: 3,
  });

  const blocks = formatWorkerThreadHeader(task);

  assert.equal(blocks.length, 3);

  assert.equal(blocks[0].type, "header");
  assert.ok(headerText(blocks[0]).startsWith("🔧"));
  assert.ok(headerText(blocks[0]).includes("Implement auth"));

  assert.equal(blocks[1].type, "section");
  assert.ok(sectionText(blocks[1]).includes("JWT middleware"));

  assert.equal(blocks[2].type, "context");
  const ctx = contextText(blocks[2]);
  assert.ok(ctx.includes("Task ID: xyz789"));
  assert.ok(ctx.includes("Worker: worker-2"));
  assert.ok(ctx.includes("Attempt: 3"));
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

console.log("slack-format tests:\n");
run();
