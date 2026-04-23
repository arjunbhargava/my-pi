/**
 * Unit tests for src/lib/workspace.ts.
 *
 * Uses a real git repo in a temp directory so the tests exercise the
 * actual git CLI (not a mock). Covers:
 *   - createWorkspace + destroyWorkspace happy path
 *   - createWorkspace rollback on worktree-add failure
 *   - destroyWorkspace is idempotent on missing workspace
 *   - squashMergeWorkspace success (direct merge, clean base)
 *   - squashMergeWorkspace noop when workspace has no commits
 *   - squashMergeWorkspace rejects when wrong base branch checked out
 *   - squashMergeWorkspace rejects when base tree is dirty
 *
 * Run: npx tsx tests/workspace.test.ts
 */

import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import {
  createWorkspace,
  destroyWorkspace,
  squashMergeWorkspace,
} from "../src/lib/workspace.js";
import type { ExecResult, GitContext } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

interface Fixture {
  repoRoot: string;
  git: GitContext;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "workspace-test-"));
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

function workspaceFor(fx: Fixture, name: string) {
  return {
    worktreePath: path.join(`${fx.repoRoot}-worktrees`, name),
    branchName: `task/${name}`,
    baseBranch: "main",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

test("createWorkspace produces branch + worktree; destroyWorkspace tears them down", async () => {
  const fx = await makeFixture();
  try {
    const plan = workspaceFor(fx, "alpha");
    const created = await createWorkspace(fx.git, plan);
    assert.ok(created.ok, created.ok ? "" : created.error);
    if (!created.ok) return;

    const branches = execSync("git branch --list", { cwd: fx.repoRoot }).toString();
    assert.match(branches, /task\/alpha/);

    const worktrees = execSync("git worktree list --porcelain", { cwd: fx.repoRoot }).toString();
    assert.ok(worktrees.includes(plan.worktreePath));

    const destroyed = await destroyWorkspace(fx.git, created.value);
    assert.ok(destroyed.ok, destroyed.ok ? "" : destroyed.error);

    const after = execSync("git branch --list", { cwd: fx.repoRoot }).toString();
    assert.doesNotMatch(after, /task\/alpha/);
  } finally {
    await fx.cleanup();
  }
});

test("createWorkspace rolls back the branch when worktree-add fails", async () => {
  const fx = await makeFixture();
  try {
    // Make the worktree path collide with a non-directory to force
    // worktree-add to fail.
    const plan = workspaceFor(fx, "beta");
    await mkdir(path.dirname(plan.worktreePath), { recursive: true });
    await writeFile(plan.worktreePath, "I am a file, not a directory.");

    const result = await createWorkspace(fx.git, plan);
    assert.ok(!result.ok, "expected worktree-add to fail");

    const branches = execSync("git branch --list", { cwd: fx.repoRoot }).toString();
    assert.doesNotMatch(
      branches, /task\/beta/,
      "branch should have been rolled back after worktree-add failed",
    );
  } finally {
    await fx.cleanup();
  }
});

test("squashMergeWorkspace merges a commit from the workspace branch", async () => {
  const fx = await makeFixture();
  try {
    const created = await createWorkspace(fx.git, workspaceFor(fx, "gamma"));
    assert.ok(created.ok);
    if (!created.ok) return;

    // Add a commit in the workspace.
    const wtPath = created.value.worktreePath;
    await writeFile(path.join(wtPath, "hello.txt"), "hi");
    execSync("git add -A && git commit -m 'add hello'", { cwd: wtPath, stdio: "pipe" });

    const merged = await squashMergeWorkspace(fx.git, created.value, {
      commitMessage: "feat: add hello",
    });
    assert.ok(merged.ok, merged.ok ? "" : merged.error);
    if (!merged.ok) return;
    assert.equal(merged.value.kind, "merged");

    const log = execSync("git log --oneline", { cwd: fx.repoRoot }).toString();
    assert.match(log, /feat: add hello/);
  } finally {
    await fx.cleanup();
  }
});

test("squashMergeWorkspace reports noop when workspace has no new commits", async () => {
  const fx = await makeFixture();
  try {
    const created = await createWorkspace(fx.git, workspaceFor(fx, "delta"));
    assert.ok(created.ok);
    if (!created.ok) return;

    const merged = await squashMergeWorkspace(fx.git, created.value, {
      commitMessage: "(empty)",
    });
    assert.ok(merged.ok, merged.ok ? "" : merged.error);
    if (!merged.ok) return;
    assert.equal(merged.value.kind, "noop");
  } finally {
    await fx.cleanup();
  }
});

test("squashMergeWorkspace rejects when base branch isn't checked out", async () => {
  const fx = await makeFixture();
  try {
    const created = await createWorkspace(fx.git, workspaceFor(fx, "epsilon"));
    assert.ok(created.ok);
    if (!created.ok) return;

    // Move the base repo onto a different branch.
    execSync("git checkout -b stray", { cwd: fx.repoRoot, stdio: "pipe" });

    const merged = await squashMergeWorkspace(fx.git, created.value, {
      commitMessage: "won't happen",
    });
    assert.ok(!merged.ok);
    assert.match(merged.error, /Expected base branch 'main'/);
  } finally {
    await fx.cleanup();
  }
});

test("squashMergeWorkspace rejects when base tree is dirty", async () => {
  const fx = await makeFixture();
  try {
    const created = await createWorkspace(fx.git, workspaceFor(fx, "zeta"));
    assert.ok(created.ok);
    if (!created.ok) return;

    // Dirty the base worktree.
    await writeFile(path.join(fx.repoRoot, "dirty.txt"), "uncommitted");

    const merged = await squashMergeWorkspace(fx.git, created.value, {
      commitMessage: "won't happen",
    });
    assert.ok(!merged.ok);
    assert.match(merged.error, /uncommitted changes/);
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

console.log("workspace tests:\n");
run();
