/**
 * Unit tests for DiagnosticsBuffer.
 *
 * All tests are pure (no subprocesses, no disk I/O) — the buffer only
 * transforms raw LSP notification payloads into DiagnosticEntry objects.
 *
 * Run: npx tsx tests/lsp-diagnostics.test.ts
 */

import { strict as assert } from "node:assert";
import { DiagnosticsBuffer } from "../src/extensions/lsp/diagnostics.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiag(opts: {
  severity?: number;
  line?: number;
  message?: string;
}): Record<string, unknown> {
  return {
    severity: opts.severity ?? 1,
    range: { start: { line: (opts.line ?? 1) - 1, character: 0 }, end: { line: (opts.line ?? 1) - 1, character: 0 } },
    message: opts.message ?? "test diagnostic",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("update stores parsed diagnostics keyed by relative path", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/src/foo.ts", [
    makeDiag({ severity: 1, line: 5, message: "Type error" }),
  ]);

  const entries = buf.getForFile("src/foo.ts");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].severity, "error");
  assert.equal(entries[0].line, 5);
  assert.equal(entries[0].message, "Type error");
  assert.equal(entries[0].path, "src/foo.ts");
});

test("update replaces previous diagnostics for same file", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/src/foo.ts", [
    makeDiag({ severity: 1, line: 1, message: "First error" }),
  ]);
  buf.update("file:///workspace/src/foo.ts", []);

  assert.equal(buf.getForFile("src/foo.ts").length, 0);
  assert.equal(buf.fileCount, 1); // key stays even when empty list
});

test("getAll returns entries across all files", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/a.ts", [makeDiag({ severity: 2, message: "Warning A" })]);
  buf.update("file:///workspace/b.ts", [makeDiag({ severity: 1, message: "Error B" })]);

  const all = buf.getAll();
  assert.equal(all.length, 2);
  assert.equal(buf.fileCount, 2);
});

test("fileCount reflects number of files with recorded diagnostic sets", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  assert.equal(buf.fileCount, 0);

  buf.update("file:///workspace/a.ts", [makeDiag({})]);
  assert.equal(buf.fileCount, 1);

  buf.update("file:///workspace/b.ts", [makeDiag({})]);
  assert.equal(buf.fileCount, 2);
});

test("clearFile removes entries for that file only", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/a.ts", [makeDiag({ message: "E" })]);
  buf.update("file:///workspace/b.ts", [makeDiag({ message: "W" })]);

  buf.clearFile("a.ts");

  assert.equal(buf.getForFile("a.ts").length, 0);
  assert.equal(buf.getForFile("b.ts").length, 1);
  assert.equal(buf.fileCount, 1);
});

test("clearAll removes all buffered diagnostics", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/a.ts", [makeDiag({})]);
  buf.update("file:///workspace/b.ts", [makeDiag({})]);

  buf.clearAll();

  assert.equal(buf.getAll().length, 0);
  assert.equal(buf.fileCount, 0);
});

test("severity mapping: 1=error 2=warning 3=info 4=hint", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/f.ts", [
    makeDiag({ severity: 1, line: 1 }),
    makeDiag({ severity: 2, line: 2 }),
    makeDiag({ severity: 3, line: 3 }),
    makeDiag({ severity: 4, line: 4 }),
  ]);

  const entries = buf.getForFile("f.ts");
  assert.equal(entries[0].severity, "error");
  assert.equal(entries[1].severity, "warning");
  assert.equal(entries[2].severity, "info");
  assert.equal(entries[3].severity, "hint");
});

test("unknown severity defaults to hint", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/f.ts", [
    { severity: 99, range: { start: { line: 0, character: 0 } }, message: "weird" },
  ]);

  assert.equal(buf.getForFile("f.ts")[0].severity, "hint");
});

test("missing severity defaults to hint", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/f.ts", [
    { range: { start: { line: 0, character: 0 } }, message: "no severity" },
  ]);

  assert.equal(buf.getForFile("f.ts")[0].severity, "hint");
});

test("line number is 1-based (LSP line 0 → DiagnosticEntry line 1)", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/f.ts", [
    { severity: 1, range: { start: { line: 0, character: 0 } }, message: "first line" },
  ]);

  assert.equal(buf.getForFile("f.ts")[0].line, 1);
});

test("URI not under workspace root is stored as-is (no prefix stripped)", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///other/path/file.ts", [makeDiag({ message: "external" })]);

  // Key is absolute path because it doesn't match workspaceRoot
  const entries = buf.getAll();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "/other/path/file.ts");
});

test("range with missing start does not throw and defaults line to 0", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  // Malformed diagnostic: range present but start is absent
  assert.doesNotThrow(() => {
    buf.update("file:///workspace/f.ts", [
      { severity: 1, range: {}, message: "malformed" },
    ]);
  });
  assert.equal(buf.getForFile("f.ts")[0].line, 0);
});

test("getForFile returns empty array for unknown file", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  assert.deepEqual(buf.getForFile("never-seen.ts"), []);
});

test("URI with percent-encoded space matches workspace root containing space", () => {
  const buf = new DiagnosticsBuffer("/my project");
  buf.update("file:///my%20project/src/foo.ts", [
    makeDiag({ severity: 1, line: 3, message: "Error" }),
  ]);
  const entries = buf.getForFile("src/foo.ts");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "src/foo.ts");
  assert.equal(entries[0].line, 3);
});

test("URI with percent-encoded unicode matches workspace root with unicode", () => {
  const buf = new DiagnosticsBuffer("/path/日本語");
  buf.update("file:///path/%E6%97%A5%E6%9C%AC%E8%AA%9E/file.ts", [
    makeDiag({ severity: 2, message: "Warning" }),
  ]);
  const entries = buf.getForFile("file.ts");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].severity, "warning");
  assert.equal(entries[0].path, "file.ts");
});

test("URI with percent-encoded hash in filename is decoded correctly", () => {
  const buf = new DiagnosticsBuffer("/workspace");
  buf.update("file:///workspace/foo%23bar.ts", [
    makeDiag({ severity: 1, message: "Hash in name" }),
  ]);
  const entries = buf.getForFile("foo#bar.ts");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "foo#bar.ts");
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
      console.log(`    ${err instanceof Error ? err.stack : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("lsp-diagnostics tests:\n");
run();
