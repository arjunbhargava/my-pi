/**
 * Unit tests for rediscoverTeams.
 *
 * Uses a mocked ExecContext for tmux so the tests don't depend on a
 * running tmux install. All filesystem work uses a real tmp dir.
 *
 * Run: npx tsx tests/rediscover-teams.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import { rediscoverTeams } from "../src/extensions/agents/discovery.js";
import { createQueue, writeQueue } from "../src/lib/task-queue.js";
import type { ExecContext, ExecResult } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Mock tmux exec
// ---------------------------------------------------------------------------

/**
 * Produce an ExecContext that simulates tmux has-session and
 * list-windows. Any session name in `live` returns code 0 (alive);
 * anything else returns code 1. list-windows returns a fixed window
 * roster per live session.
 */
function mockTmux(live: Map<string, string[]>): ExecContext {
  return {
    cwd: "/",
    exec: async (cmd: string, args: string[]): Promise<ExecResult> => {
      if (cmd !== "tmux") return dead();

      // has-session -t <name>
      if (args[0] === "has-session" && args[1] === "-t") {
        return live.has(args[2]) ? ok("") : dead();
      }

      // list-windows -t <name> -F "..."
      if (args[0] === "list-windows" && args[1] === "-t") {
        const windows = live.get(args[2]);
        if (!windows) return dead();
        const lines = windows.map((name, i) => `${i}\t${name}\t${i === 0 ? "1" : "0"}`);
        return ok(lines.join("\n") + "\n");
      }

      return dead();
    },
  };
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const dead = (): ExecResult => ({ stdout: "", stderr: "", code: 1, killed: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let baseDir: string;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "rediscover-test-"));
  baseDir = path.join(tmpDir, "worktrees");
  await mkdir(baseDir, { recursive: true });
}

async function cleanup(): Promise<void> {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}

async function writeTeamQueue(
  teamId: string,
  goal: string,
  tmuxSession: string,
): Promise<string> {
  const queuePath = path.join(baseDir, `.team-${teamId}.json`);
  const queue = createQueue(teamId, goal, "main", tmuxSession);
  const result = await writeQueue(queuePath, queue);
  if (!result.ok) throw new Error(result.error);
  return queuePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

test("returns empty when baseDir does not exist", async () => {
  await setup();
  try {
    const ctx = mockTmux(new Map());
    const result = await rediscoverTeams(ctx, path.join(tmpDir, "nope"), tmpDir, tmpDir);
    assert.deepEqual(result.live, []);
    assert.deepEqual(result.stale, []);
  } finally {
    await cleanup();
  }
});

test("returns empty when baseDir contains no queue files", async () => {
  await setup();
  try {
    await writeFile(path.join(baseDir, "unrelated.txt"), "hi");
    const ctx = mockTmux(new Map());
    const result = await rediscoverTeams(ctx, baseDir, tmpDir, tmpDir);
    assert.deepEqual(result.live, []);
    assert.deepEqual(result.stale, []);
  } finally {
    await cleanup();
  }
});

test("marks queue files with dead tmux sessions as stale", async () => {
  await setup();
  try {
    const queuePath = await writeTeamQueue("abcd1234", "Dead team", "pi-team-dead");
    const ctx = mockTmux(new Map()); // no live sessions
    const result = await rediscoverTeams(ctx, baseDir, tmpDir, tmpDir);
    assert.equal(result.live.length, 0);
    assert.deepEqual(result.stale, [queuePath]);
  } finally {
    await cleanup();
  }
});

test("rediscovers a live team with its agent list", async () => {
  await setup();
  try {
    await writeTeamQueue("aaaa0001", "Build auth", "pi-team-build-auth");
    const ctx = mockTmux(new Map([
      ["pi-team-build-auth", ["board", "orchestrator", "evaluator", "worker-abc123"]],
    ]));

    const result = await rediscoverTeams(ctx, baseDir, "/repo", "/repo");
    assert.equal(result.live.length, 1);
    assert.equal(result.stale.length, 0);

    const team = result.live[0];
    assert.equal(team.teamId, "aaaa0001");
    assert.equal(team.goal, "Build auth");
    assert.equal(team.tmuxSession, "pi-team-build-auth");
    assert.equal(team.targetBranch, "main");
    assert.equal(team.repoRoot, "/repo");
    assert.equal(team.workingDir, "/repo");

    // board window should not appear as an agent
    const names = team.agents.map((a) => a.name);
    assert.deepEqual(names, ["orchestrator", "evaluator", "worker-abc123"]);

    const worker = team.agents.find((a) => a.name.startsWith("worker-"));
    assert.equal(worker?.role, "worker");
    const permanent = team.agents.find((a) => a.name === "orchestrator");
    assert.equal(permanent?.role, "permanent");
  } finally {
    await cleanup();
  }
});

test("partitions live and stale across multiple queues", async () => {
  await setup();
  try {
    const aliveQueue = await writeTeamQueue("aaaa0002", "Alive team", "pi-team-alive");
    const deadQueue = await writeTeamQueue("bbbb0003", "Dead team", "pi-team-dead");

    const ctx = mockTmux(new Map([
      ["pi-team-alive", ["board", "orchestrator"]],
    ]));

    const result = await rediscoverTeams(ctx, baseDir, tmpDir, tmpDir);
    assert.equal(result.live.length, 1);
    assert.equal(result.live[0].queuePath, aliveQueue);
    assert.deepEqual(result.stale, [deadQueue]);
  } finally {
    await cleanup();
  }
});

test("marks malformed queue files as stale", async () => {
  await setup();
  try {
    const bad = path.join(baseDir, ".team-badf00d.json");
    await writeFile(bad, "not json");
    const ctx = mockTmux(new Map());
    const result = await rediscoverTeams(ctx, baseDir, tmpDir, tmpDir);
    assert.equal(result.live.length, 0);
    assert.deepEqual(result.stale, [bad]);
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

console.log("rediscoverTeams tests:\n");
run();
