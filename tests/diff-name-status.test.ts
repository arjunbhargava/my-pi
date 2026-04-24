/**
 * Regression tests for src/lib/git.ts :: diffNameStatus.
 *
 * Exists because rich squash-merge commit messages were reporting
 * phantom deletes: a worker branch would land with a "Changes:" list
 * claiming it removed files it never touched. Root cause was a
 * two-dot `git diff main worker-branch` which reports as "D" every
 * file that landed on main *after* the worker branched off.
 *
 * The helper now uses three-dot semantics so the diff is anchored at
 * the merge-base. These tests construct the exact divergent scenario
 * against a real git repo in a temp directory.
 *
 * Run: npx tsx tests/diff-name-status.test.ts
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import { diffNameStatus } from "../src/lib/git.js";
import type { ExecResult, GitContext } from "../src/lib/types.js";

// ---------------------------------------------------------------------------
// Test rig (git-shelling)
// ---------------------------------------------------------------------------

interface Fixture {
  repoRoot: string;
  git: GitContext;
  cleanup: () => Promise<void>;
}

async function makeRepo(): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "diff-name-status-test-"));
  const sh = (cmd: string): void => { execSync(cmd, { cwd: repoRoot, stdio: "pipe" }); };
  sh("git init -b main");
  sh("git config user.email test@example.com");
  sh("git config user.name Tester");
  sh("git commit --allow-empty -m init");
  const git: GitContext = {
    cwd: repoRoot,
    exec: (cmd, args) => runCommand(cmd, args, repoRoot),
  };
  return {
    repoRoot,
    git,
    cleanup: async () => {
      await rm(repoRoot, { recursive: true, force: true });
    },
  };
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      const stdout = execSync(
        `${cmd} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
        { cwd, stdio: ["ignore", "pipe", "pipe"] },
      );
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

function shIn(cwd: string, cmd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

test("only reports changes introduced by the branch, not by main after branching", async () => {
  const { repoRoot, git, cleanup } = await makeRepo();
  try {
    // Commit a shared starting file on main so we have meaningful history.
    await writeFile(path.join(repoRoot, "shared.txt"), "shared v1\n");
    shIn(repoRoot, "git add shared.txt");
    shIn(repoRoot, "git commit -m 'add shared'");

    // Branch "feature" off main at this commit; feature adds its own file.
    shIn(repoRoot, "git checkout -b feature");
    await writeFile(path.join(repoRoot, "feature-only.txt"), "feature contribution\n");
    shIn(repoRoot, "git add feature-only.txt");
    shIn(repoRoot, "git commit -m 'feature contribution'");

    // Main advances independently: other workers land two new files and
    // modify the shared one. The feature branch never saw these changes.
    shIn(repoRoot, "git checkout main");
    await writeFile(path.join(repoRoot, "main-new-a.txt"), "landed on main\n");
    await writeFile(path.join(repoRoot, "main-new-b.txt"), "also on main\n");
    await writeFile(path.join(repoRoot, "shared.txt"), "shared v2 (main side)\n");
    shIn(repoRoot, "git add .");
    shIn(repoRoot, "git commit -m 'main advances'");

    // Under the old two-dot diff, this would claim feature "deleted"
    // main-new-a.txt + main-new-b.txt and "modified" shared.txt back to
    // the feature-branch content. Three-dot anchors at the merge-base,
    // so feature's only contribution is the one new file.
    const result = await diffNameStatus(git, "main", "feature");
    assert.ok(result.ok, result.ok ? "" : result.error);
    if (!result.ok) return;

    assert.deepEqual(
      result.value,
      [{ status: "A", path: "feature-only.txt" }],
      "should only report the file the feature branch added",
    );
  } finally {
    await cleanup();
  }
});

test("reports A / M / D on the branch side correctly", async () => {
  const { repoRoot, git, cleanup } = await makeRepo();
  try {
    // Set up a starting file on main.
    await writeFile(path.join(repoRoot, "keep.txt"), "will be modified\n");
    await writeFile(path.join(repoRoot, "doomed.txt"), "will be deleted on branch\n");
    shIn(repoRoot, "git add .");
    shIn(repoRoot, "git commit -m 'seed'");

    // Branch adds, modifies, and deletes a file — each should show.
    shIn(repoRoot, "git checkout -b feature");
    await writeFile(path.join(repoRoot, "added.txt"), "new on the branch\n");
    await writeFile(path.join(repoRoot, "keep.txt"), "modified on the branch\n");
    shIn(repoRoot, "git rm doomed.txt");
    shIn(repoRoot, "git add .");
    shIn(repoRoot, "git commit -m 'three kinds of change'");

    const result = await diffNameStatus(git, "main", "feature");
    assert.ok(result.ok, result.ok ? "" : result.error);
    if (!result.ok) return;

    const byPath = new Map(result.value.map((e) => [e.path, e.status]));
    assert.equal(byPath.get("added.txt"), "A");
    assert.equal(byPath.get("keep.txt"), "M");
    assert.equal(byPath.get("doomed.txt"), "D");
    assert.equal(result.value.length, 3, "no extra entries");
  } finally {
    await cleanup();
  }
});

test("empty diff for a branch with no new commits", async () => {
  const { repoRoot, git, cleanup } = await makeRepo();
  try {
    shIn(repoRoot, "git checkout -b feature");
    // feature and main point at the same commit.
    const result = await diffNameStatus(git, "main", "feature");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value, []);
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
      console.log(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("diff-name-status tests:\n");
run();
