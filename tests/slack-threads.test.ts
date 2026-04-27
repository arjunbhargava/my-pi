/**
 * Unit tests for src/lib/slack-threads.ts
 *
 * Covers: createThreadState shape, save+load round-trip, threadStatePath
 * transformation, and loadThreadState on a missing file.
 *
 * Run: npx tsx tests/slack-threads.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createThreadState,
  loadThreadState,
  saveThreadState,
  threadStatePath,
} from "../src/lib/slack-threads.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

type TestFn = () => Promise<void> | void;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("createThreadState returns correct shape with null teamMessageTs and empty maps", () => {
  const state = createThreadState("team-abc", "C0123");
  assert.equal(state.teamId, "team-abc");
  assert.equal(state.channelId, "C0123");
  assert.equal(state.teamMessageTs, null);
  assert.deepEqual(state.taskThreads, {});
  assert.deepEqual(state.lastPostedTs, {});
  assert.deepEqual(state.lastSeenTs, {});
});

test("saveThreadState + loadThreadState round-trip preserves all fields", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "slack-threads-test-"));
  try {
    const statePath = path.join(tmpDir, ".team-abc.slack.json");
    const state = createThreadState("team-abc", "C0456");
    state.teamMessageTs = "1234567890.123456";
    state.taskThreads["task1"] = "9999999.000001";
    state.lastPostedTs["task1"] = "9999999.000002";
    state.lastSeenTs["9999999.000001"] = "9999999.000003";

    const saveResult = await saveThreadState(statePath, state);
    assert.ok(saveResult.ok, `saveThreadState failed: ${!saveResult.ok ? saveResult.error : ""}`);

    const loadResult = await loadThreadState(statePath);
    assert.ok(loadResult.ok, `loadThreadState failed: ${!loadResult.ok ? loadResult.error : ""}`);

    assert.deepEqual(loadResult.value, state);
  } finally {
    await rm(tmpDir, { recursive: true });
  }
});

test("threadStatePath replaces .json with .slack.json", () => {
  assert.equal(
    threadStatePath(".team-abc.json"),
    ".team-abc.slack.json",
  );
  assert.equal(
    threadStatePath("/path/to/.team-8f24832f.json"),
    "/path/to/.team-8f24832f.slack.json",
  );
});

test("loadThreadState on missing file returns { ok: false }", async () => {
  const result = await loadThreadState("/tmp/__nonexistent_slack_threads_test__.slack.json");
  assert.equal(result.ok, false);
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

console.log("slack-threads tests:\n");
run();
