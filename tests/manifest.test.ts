/**
 * Unit tests for the role-based tool manifest.
 *
 * Verifies that each role gets exactly the tools it should, and that
 * no tool leaks across role boundaries (the root cause of the
 * wait_for_merges/monitor_tasks confusion).
 *
 * Run: npx tsx tests/manifest.test.ts
 */

import { strict as assert } from "node:assert";

import { getToolManifest, type ToolManifest } from "../src/extensions/agents/team-agent/manifest.js";
import type { TeamAgentConfig } from "../src/extensions/agents/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<TeamAgentConfig>): TeamAgentConfig {
  return {
    teamId: "test-team",
    goal: "Test goal",
    agentName: "test-agent",
    role: "worker",
    queuePath: "/tmp/queue.json",
    capabilities: [],
    tmuxSession: "pi-team-test",
    workingDir: "/tmp/work",
    teamAgentExtensionPath: "/tmp/ext.ts",
    agentsDirs: [],
    ...overrides,
  };
}

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => void }> = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("orchestrator gets dispatch tools, add_task, read_queue — no complete, no wait tools", () => {
  const manifest = getToolManifest(makeConfig({
    role: "permanent",
    agentName: "orchestrator",
    capabilities: ["dispatch"],
  }));

  assert.equal(manifest.readQueue, true);
  assert.equal(manifest.addTask, true);
  assert.equal(manifest.dispatch, true);
  // Must NOT have these
  assert.equal(manifest.completeTask, false);
  assert.equal(manifest.waitForVerdict, false);
  assert.equal(manifest.review, false);
});

test("evaluator gets review tools and read_queue — no dispatch, no complete, no wait_for_closes", () => {
  const manifest = getToolManifest(makeConfig({
    role: "permanent",
    agentName: "evaluator",
    capabilities: ["close"],
  }));

  assert.equal(manifest.readQueue, true);
  assert.equal(manifest.review, true);
  // Must NOT have these
  assert.equal(manifest.addTask, false);
  assert.equal(manifest.completeTask, false);
  assert.equal(manifest.waitForVerdict, false);
  assert.equal(manifest.dispatch, false);
});

test("worker gets read_queue, complete_task, wait_for_verdict — nothing else", () => {
  const manifest = getToolManifest(makeConfig({
    role: "worker",
    agentName: "worker-abc123",
    capabilities: [],
  }));

  assert.equal(manifest.readQueue, true);
  assert.equal(manifest.completeTask, true);
  assert.equal(manifest.waitForVerdict, true);
  // Must NOT have these
  assert.equal(manifest.addTask, false);
  assert.equal(manifest.dispatch, false);
  assert.equal(manifest.review, false);
});

test("code-reviewer (as worker) gets read_queue, complete_task, wait_for_verdict — same as any worker", () => {
  const manifest = getToolManifest(makeConfig({
    role: "worker",
    agentName: "worker-abc123",
    capabilities: [],
  }));

  assert.equal(manifest.readQueue, true);
  assert.equal(manifest.completeTask, true);
  assert.equal(manifest.waitForVerdict, true);
  // Must NOT have these
  assert.equal(manifest.addTask, false);
  assert.equal(manifest.dispatch, false);
  assert.equal(manifest.review, false);
});

test("no role has both monitor (dispatch) and review", () => {
  const configs: Partial<TeamAgentConfig>[] = [
    { role: "permanent", agentName: "orchestrator", capabilities: ["dispatch"] },
    { role: "permanent", agentName: "evaluator", capabilities: ["close"] },
    { role: "worker", agentName: "worker-1", capabilities: [] },
  ];

  for (const cfg of configs) {
    const manifest = getToolManifest(makeConfig(cfg));
    if (manifest.dispatch && manifest.review) {
      assert.fail(`Role '${cfg.agentName}' has both dispatch and review`);
    }
  }
});

test("no role has both completeTask and review", () => {
  const configs: Partial<TeamAgentConfig>[] = [
    { role: "permanent", agentName: "orchestrator", capabilities: ["dispatch"] },
    { role: "permanent", agentName: "evaluator", capabilities: ["close"] },
    { role: "worker", agentName: "worker-1", capabilities: [] },
  ];

  for (const cfg of configs) {
    const manifest = getToolManifest(makeConfig(cfg));
    if (manifest.completeTask && manifest.review) {
      assert.fail(`Role '${cfg.agentName}' has both completeTask and review`);
    }
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

console.log("manifest tests:\n");
run();
