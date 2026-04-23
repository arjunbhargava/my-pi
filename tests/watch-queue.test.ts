/**
 * Unit tests for watchQueueUntil.
 *
 * Exercises: immediate satisfaction, wakeup on write, timeout,
 * abort signal, heartbeat fallback, and malformed-read skip.
 *
 * Run: npx tsx tests/watch-queue.test.ts
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import { writeQueue, createQueue, addTask } from "../src/lib/task-queue.js";
import { watchQueueUntil } from "../src/extensions/agents/team-agent/watch.js";
import type { TaskQueue } from "../src/lib/types.js";

let tmpDir: string;
let queuePath: string;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "watch-queue-test-"));
  queuePath = path.join(tmpDir, ".team-test.json");
  const queue = createQueue("test", "test goal", "main");
  await writeQueue(queuePath, queue);
}

async function cleanup(): Promise<void> {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("resolves immediately when predicate is satisfied on first read", async () => {
  await setup();
  try {
    const queue = createQueue("test", "test", "main");
    addTask(queue, "already here", "already here", "tester");
    await writeQueue(queuePath, queue);

    const start = Date.now();
    const outcome = await watchQueueUntil(
      queuePath,
      async (q) => q.tasks.length > 0 ? "done" : "continue",
      { timeoutMs: 5000 },
    );
    const elapsed = Date.now() - start;

    assert.equal(outcome, "done");
    assert.ok(elapsed < 1000, `should return promptly (took ${elapsed}ms)`);
  } finally {
    await cleanup();
  }
});

test("wakes on queue write and resolves via fs.watch", async () => {
  await setup();
  try {
    const start = Date.now();

    // Fire a write 100ms from now; the watcher should catch it.
    setTimeout(() => {
      void (async () => {
        const queue = createQueue("test", "test", "main");
        addTask(queue, "arrived", "arrived", "tester");
        await writeQueue(queuePath, queue);
      })();
    }, 100);

    const outcome = await watchQueueUntil(
      queuePath,
      async (q) => q.tasks.length > 0 ? "done" : "continue",
      { timeoutMs: 5000 },
    );
    const elapsed = Date.now() - start;

    assert.equal(outcome, "done");
    assert.ok(elapsed < 2000, `should wake within fs event latency (took ${elapsed}ms)`);
  } finally {
    await cleanup();
  }
});

test("times out when predicate is never satisfied", async () => {
  await setup();
  try {
    const start = Date.now();
    const outcome = await watchQueueUntil(
      queuePath,
      async () => "continue",
      { timeoutMs: 300 },
    );
    const elapsed = Date.now() - start;

    assert.equal(outcome, "timeout");
    assert.ok(elapsed >= 250 && elapsed < 1500, `should honour timeout (took ${elapsed}ms)`);
  } finally {
    await cleanup();
  }
});

test("honours abort signal", async () => {
  await setup();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const outcome = await watchQueueUntil(
      queuePath,
      async () => "continue",
      { timeoutMs: 10_000, signal: controller.signal },
    );
    const elapsed = Date.now() - start;

    assert.equal(outcome, "aborted");
    assert.ok(elapsed < 500, `should abort promptly (took ${elapsed}ms)`);
  } finally {
    await cleanup();
  }
});

test("heartbeat fires handler even without queue writes", async () => {
  await setup();
  try {
    let invocations = 0;

    // Handler returns "done" on the 3rd invocation — proving the
    // heartbeat keeps firing without any queue writes.
    const outcome = await watchQueueUntil(
      queuePath,
      async () => {
        invocations++;
        return invocations >= 3 ? "done" : "continue";
      },
      { timeoutMs: 5000, heartbeatMs: 100 },
    );

    assert.equal(outcome, "done");
    assert.ok(invocations >= 3, `handler ran ${invocations} times`);
  } finally {
    await cleanup();
  }
});

test("skips when file read fails but recovers on next wake", async () => {
  await setup();
  try {
    // Delete the file so the initial read fails.
    await rm(queuePath);

    let sawValidQueue = false;

    const writeTimer = setTimeout(() => {
      void (async () => {
        const queue = createQueue("test", "test", "main");
        addTask(queue, "now readable", "now readable", "tester");
        await writeQueue(queuePath, queue);
      })();
    }, 150);

    const outcome = await watchQueueUntil(
      queuePath,
      async (q: TaskQueue) => {
        sawValidQueue = true;
        return q.tasks.length > 0 ? "done" : "continue";
      },
      { timeoutMs: 3000, heartbeatMs: 100 },
    );

    clearTimeout(writeTimer);
    assert.equal(outcome, "done");
    assert.ok(sawValidQueue, "handler should have been called once the file reappeared");
  } finally {
    await cleanup();
  }
});

test("does not lose wakes that arrive during handler execution", async () => {
  await setup();
  try {
    // The handler awaits for 200ms on its first call, during which
    // another write fires. We verify the handler is re-invoked and
    // sees the new state (i.e., the mid-handler wake wasn't dropped).
    let callCount = 0;

    const writeTimer = setTimeout(() => {
      void (async () => {
        const queue = createQueue("test", "test", "main");
        addTask(queue, "mid-handler", "mid-handler", "tester");
        await writeQueue(queuePath, queue);
      })();
    }, 100);

    const outcome = await watchQueueUntil(
      queuePath,
      async (q) => {
        callCount++;
        if (callCount === 1) {
          // Hold the handler so the queue write lands during execution.
          await new Promise((r) => setTimeout(r, 300));
          return "continue";
        }
        return q.tasks.length > 0 ? "done" : "continue";
      },
      { timeoutMs: 3000 },
    );

    clearTimeout(writeTimer);
    assert.equal(outcome, "done");
    assert.ok(callCount >= 2, `handler should be re-invoked (ran ${callCount} times)`);
  } finally {
    await cleanup();
  }
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
      console.log(`    ${err instanceof Error ? err.stack : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("watchQueueUntil tests:\n");
run();
