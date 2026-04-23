/**
 * End-to-end test: checkpoint + accept commits carry the expected
 * rich body (Prompt/Prompts + Changes sections).
 *
 * Uses a real git repo in a temp dir so the tests exercise the
 * actual commit flow, not the string formatter in isolation.
 *
 * Run: npx tsx tests/checkpoint-commit.test.ts
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import { createCheckpoint } from "../src/extensions/worktree/checkpoint.js";
import { acceptTask } from "../src/extensions/worktree/accept-reject.js";
import { createWorkspace } from "../src/lib/workspace.js";
import type { ExecResult, GitContext } from "../src/lib/types.js";
import type { TaskState } from "../src/extensions/worktree/types.js";

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

interface Fixture {
  repoRoot: string;
  git: GitContext;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "checkpoint-commit-test-"));
  execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: repoRoot, stdio: "pipe" });
  execSync("git config user.name Tester", { cwd: repoRoot, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: repoRoot, stdio: "pipe" });

  const git: GitContext = {
    cwd: repoRoot,
    exec: (cmd, args) => runCommand(cmd, args, repoRoot),
  };

  return {
    repoRoot,
    git,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(`${repoRoot}-worktrees`, { recursive: true, force: true });
    },
  };
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      const stdout = execSync(`${cmd} ${args.map(quote).join(" ")}`, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      resolve({ stdout: stdout.toString(), stderr: "", code: 0, killed: false });
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
      resolve({
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
        code: e.status ?? 1,
        killed: false,
      });
    }
  });
}

function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function readCommitBody(cwd: string, ref = "HEAD"): string {
  return execSync(`git show -s --format=%B ${ref}`, { cwd }).toString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

test("checkpoint commit carries Prompt and Changes sections", async () => {
  const fx = await makeFixture();
  try {
    const plan = {
      worktreePath: path.join(`${fx.repoRoot}-worktrees`, "alpha"),
      branchName: "task/alpha",
      baseBranch: "main",
    };
    const ws = await createWorkspace(fx.git, plan);
    assert.ok(ws.ok, ws.ok ? "" : ws.error);
    if (!ws.ok) return;

    // Make some changes inside the worktree.
    await writeFile(path.join(plan.worktreePath, "hello.ts"), "export const x = 1;\n");
    await writeFile(path.join(plan.worktreePath, "world.ts"), "export const y = 2;\n");

    const wsGit: GitContext = {
      cwd: plan.worktreePath,
      exec: (cmd, args) => runCommand(cmd, args, plan.worktreePath),
    };

    const cp = await createCheckpoint(wsGit, "please add hello and world");
    assert.ok(cp.ok, cp.ok ? "" : cp.error);
    if (!cp.ok) return;
    assert.ok(cp.value, "expected a checkpoint record (changes were present)");

    const body = readCommitBody(plan.worktreePath);
    assert.match(body, /^checkpoint:/, "subject starts with checkpoint:");
    assert.match(body, /Prompt:\nplease add hello and world/);
    assert.match(body, /Changes:\n- add hello\.ts\n- add world\.ts/);
  } finally {
    await fx.cleanup();
  }
});

test("checkpoint with no changes skips commit and returns null", async () => {
  const fx = await makeFixture();
  try {
    const plan = {
      worktreePath: path.join(`${fx.repoRoot}-worktrees`, "beta"),
      branchName: "task/beta",
      baseBranch: "main",
    };
    const ws = await createWorkspace(fx.git, plan);
    assert.ok(ws.ok);
    if (!ws.ok) return;

    const wsGit: GitContext = {
      cwd: plan.worktreePath,
      exec: (cmd, args) => runCommand(cmd, args, plan.worktreePath),
    };

    const cp = await createCheckpoint(wsGit, "did nothing");
    assert.ok(cp.ok);
    if (!cp.ok) return;
    assert.equal(cp.value, null, "clean tree should produce no checkpoint");
  } finally {
    await fx.cleanup();
  }
});

test("acceptTask squash commit carries Prompts and Changes sections", async () => {
  const fx = await makeFixture();
  try {
    const plan = {
      worktreePath: path.join(`${fx.repoRoot}-worktrees`, "gamma"),
      branchName: "task/gamma",
      baseBranch: "main",
    };
    const ws = await createWorkspace(fx.git, plan);
    assert.ok(ws.ok);
    if (!ws.ok) return;

    const wsGit: GitContext = {
      cwd: plan.worktreePath,
      exec: (cmd, args) => runCommand(cmd, args, plan.worktreePath),
    };

    // Two checkpoints simulating two user turns.
    await writeFile(path.join(plan.worktreePath, "a.ts"), "// first\n");
    const cp1 = await createCheckpoint(wsGit, "add first module");
    assert.ok(cp1.ok && cp1.value);

    await writeFile(path.join(plan.worktreePath, "b.ts"), "// second\n");
    const cp2 = await createCheckpoint(wsGit, "add second module");
    assert.ok(cp2.ok && cp2.value);

    // Build a TaskState that mirrors what the worktree extension tracks.
    const task: TaskState = {
      id: "t1",
      description: "feature: two modules",
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      checkpoints: [
        { sha: cp1.value!.sha, description: "add first module", timestamp: Date.now() },
        { sha: cp2.value!.sha, description: "add second module", timestamp: Date.now() },
      ],
      status: "active",
      createdAt: Date.now(),
    };

    const result = await acceptTask(fx.git, task, "feat: two modules");
    assert.ok(result.ok, result.ok ? "" : result.error);
    if (!result.ok) return;

    const body = readCommitBody(fx.repoRoot);
    assert.match(body, /^feat: two modules/);
    assert.match(body, /Prompts:\n- add first module\n- add second module/);
    assert.match(body, /Changes:\n- add a\.ts\n- add b\.ts/);
  } finally {
    await fx.cleanup();
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

console.log("checkpoint-commit tests:\n");
run();
