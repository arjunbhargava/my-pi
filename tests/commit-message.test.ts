/**
 * Unit tests for src/lib/commit-message.ts.
 *
 * Run: npx tsx tests/commit-message.test.ts
 */

import { strict as assert } from "node:assert";

import {
  composeCommitMessage,
  firstLineSummary,
  formatFileChange,
  formatFileChanges,
} from "../src/lib/commit-message.js";
import type { DiffFileEntry } from "../src/lib/git.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// composeCommitMessage
// ---------------------------------------------------------------------------

test("subject-only output has a single trailing newline", () => {
  const msg = composeCommitMessage("feat: something", []);
  assert.equal(msg, "feat: something\n");
});

test("bulleted section renders as heading + dashes", () => {
  const msg = composeCommitMessage("feat: x", [
    { heading: "Changes", items: ["add a.ts", "modify b.ts"] },
  ]);
  assert.equal(msg, "feat: x\n\nChanges:\n- add a.ts\n- modify b.ts\n");
});

test("body section renders as heading + paragraph", () => {
  const msg = composeCommitMessage("feat: x", [
    { heading: "Description", body: "line one\nline two" },
  ]);
  assert.equal(msg, "feat: x\n\nDescription:\nline one\nline two\n");
});

test("empty bulleted section is omitted", () => {
  const msg = composeCommitMessage("feat: x", [
    { heading: "Prompts", items: [] },
    { heading: "Changes", items: ["add a.ts"] },
  ]);
  assert.equal(msg, "feat: x\n\nChanges:\n- add a.ts\n");
});

test("whitespace-only body section is omitted", () => {
  const msg = composeCommitMessage("feat: x", [
    { heading: "Description", body: "   \n\n  " },
    { heading: "Changes", items: ["add a.ts"] },
  ]);
  assert.equal(msg, "feat: x\n\nChanges:\n- add a.ts\n");
});

test("multiple sections interleave with a single blank line each", () => {
  const msg = composeCommitMessage("feat: x", [
    { heading: "Description", body: "the thing" },
    { heading: "Changes", items: ["add a.ts"] },
  ]);
  assert.equal(msg, "feat: x\n\nDescription:\nthe thing\n\nChanges:\n- add a.ts\n");
});

test("subject is trimmed", () => {
  const msg = composeCommitMessage("  feat: x  ", []);
  assert.equal(msg, "feat: x\n");
});

// ---------------------------------------------------------------------------
// formatFileChange
// ---------------------------------------------------------------------------

test("formatFileChange uses readable verbs", () => {
  const cases: Array<[DiffFileEntry, string]> = [
    [{ status: "A", path: "foo.ts" }, "add foo.ts"],
    [{ status: "M", path: "bar.ts" }, "modify bar.ts"],
    [{ status: "D", path: "baz.ts" }, "delete baz.ts"],
    [{ status: "T", path: "q.ts" }, "change type q.ts"],
  ];
  for (const [entry, expected] of cases) {
    assert.equal(formatFileChange(entry), expected);
  }
});

test("formatFileChange renders renames with arrow", () => {
  const entry: DiffFileEntry = { status: "R", path: "old.ts", renamedTo: "new.ts" };
  assert.equal(formatFileChange(entry), "rename old.ts → new.ts");
});

test("formatFileChanges batches", () => {
  const entries: DiffFileEntry[] = [
    { status: "A", path: "a.ts" },
    { status: "M", path: "b.ts" },
  ];
  assert.deepEqual(formatFileChanges(entries), ["add a.ts", "modify b.ts"]);
});

// ---------------------------------------------------------------------------
// firstLineSummary
// ---------------------------------------------------------------------------

test("firstLineSummary returns the first non-empty line", () => {
  assert.equal(firstLineSummary("\n\n  hello world  \nmore"), "hello world");
});

test("firstLineSummary caps long lines with an ellipsis", () => {
  const long = "a".repeat(200);
  const summary = firstLineSummary(long, 50);
  assert.equal(summary.length, 50);
  assert.ok(summary.endsWith("…"));
});

test("firstLineSummary passes short lines through", () => {
  assert.equal(firstLineSummary("short", 120), "short");
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

console.log("commit-message tests:\n");
run();
