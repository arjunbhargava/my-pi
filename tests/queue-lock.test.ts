/**
 * Regression test for the queue write lock.
 *
 * Before the lock was introduced, concurrent add_task calls from
 * multiple agents would clobber each other: two agents read the same
 * queue version, each appended their task, each wrote it back, and
 * whoever wrote last dropped the other's task on the floor.
 *
 * This test replicates the runtime's lock pattern (proper-lockfile
 * around load-mutate-save) and verifies every concurrent add shows up
 * in the final file.
 *
 * Run: npx tsx tests/queue-lock.test.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import * as lockfile from "proper-lockfile";

import {
  addTask,
  createQueue,
  readQueue,
  writeQueue,
} from "../src/lib/task-queue.js";
import type { TaskQueue } from "../src/lib/types.js";

// Mirrors TeamAgentRuntime.withQueueLock — kept in sync with runtime.ts.
async function withQueueLock<T>(
  queuePath: string,
  fn: (queue: TaskQueue) => Promise<T> | T,
): Promise<T> {
  // Test retry budget is generous so 50-way pathological contention
  // always succeeds. The production budget in runtime.ts is sized for
  // realistic agent counts (handful of workers), not stress tests.
  const release = await lockfile.lock(queuePath, {
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100, factor: 1.2 },
    stale: 10_000,
  });
  try {
    const readResult = await readQueue(queuePath);
    if (!readResult.ok) throw new Error(readResult.error);
    const queue = readResult.value;
    const result = await fn(queue);
    const writeResult = await writeQueue(queuePath, queue);
    if (!writeResult.ok) throw new Error(writeResult.error);
    return result;
  } finally {
    await release();
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

async function withTempQueue(fn: (queuePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "queue-lock-test-"));
  const queuePath = path.join(dir, "queue.json");
  const q = createQueue("team-lock", "Lock test", "main", "pi-team-lock");
  const w = await writeQueue(queuePath, q);
  assert.ok(w.ok);
  try {
    await fn(queuePath);
  } finally {
    // proper-lockfile cleans up its `.lock` dir on release, but on
    // macOS the removal is occasionally observable to the next rm()
    // as ENOTEMPTY. A short retry loop papers over that race.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
}

test("concurrent add_task: every task is persisted", async () => {
  await withTempQueue(async (queuePath) => {
    const N = 50;
    const adds = Array.from({ length: N }, (_, i) =>
      withQueueLock(queuePath, (queue) => {
        addTask(queue, `task-${i}`, `desc-${i}`, `agent-${i % 5}`);
      }),
    );
    await Promise.all(adds);

    const read = await readQueue(queuePath);
    assert.ok(read.ok);
    if (!read.ok) return;

    assert.equal(read.value.tasks.length, N, `expected ${N} tasks, got ${read.value.tasks.length}`);
    const titles = new Set(read.value.tasks.map((t) => t.title));
    for (let i = 0; i < N; i++) {
      assert.ok(titles.has(`task-${i}`), `missing task-${i}`);
    }
  });
});

test("lock survives a callback that throws", async () => {
  await withTempQueue(async (queuePath) => {
    await assert.rejects(
      withQueueLock(queuePath, () => {
        throw new Error("boom");
      }),
      /boom/,
    );

    // Lock must be released — otherwise this second call would hang on
    // retries until it times out. Quick success proves the finally{}
    // fired.
    await withQueueLock(queuePath, (queue) => {
      addTask(queue, "after-throw", "desc", "agent");
    });

    const read = await readQueue(queuePath);
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.equal(read.value.tasks.length, 1);
    assert.equal(read.value.tasks[0].title, "after-throw");
  });
});

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
      console.log(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("queue-lock tests:\n");
run();
