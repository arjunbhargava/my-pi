/**
 * Unit tests for ServerRegistry — guard behaviour and state invariants.
 *
 * These tests do not spawn real language servers. They verify:
 *   - Initial state (empty active languages, no buffers)
 *   - Error returns for unsupported file extensions and unknown language IDs
 *   - disposeAll safety on an empty registry
 *   - No stale state after a failed spawn attempt
 *
 * Run: npx tsx tests/lsp-registry.test.ts
 */

import { strict as assert } from "node:assert";
import { ServerRegistry } from "../src/extensions/lsp/registry.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("getActiveLanguages returns empty array initially", async () => {
  const reg = new ServerRegistry("/workspace");
  assert.deepEqual(reg.getActiveLanguages(), []);
});

test("getDiagnosticsBuffer returns undefined for unknown language", async () => {
  const reg = new ServerRegistry("/workspace");
  assert.equal(reg.getDiagnosticsBuffer("typescript"), undefined);
  assert.equal(reg.getDiagnosticsBuffer("python"), undefined);
});

test("getClientForFile returns error for unsupported extension", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.getClientForFile("/workspace/file.xml");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("getClientForFile returns error for file with no extension", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.getClientForFile("/workspace/Makefile");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string");
});

test("getClientForFile error message includes the file path", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.getClientForFile("/workspace/config.toml");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("/workspace/config.toml"));
});

test("getClientForLanguage returns error for unsupported language", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.getClientForLanguage("cobol");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("getClientForLanguage error message includes the language ID", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.getClientForLanguage("brainfuck");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("brainfuck"));
});

test("ensureDocumentOpen returns error for unsupported extension", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.ensureDocumentOpen("/workspace/schema.json");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string");
});

test("notifyChange returns error for unsupported extension", async () => {
  const reg = new ServerRegistry("/workspace");
  const result = await reg.notifyChange("/workspace/config.yaml", "content");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string");
});

test("disposeAll on empty registry does not throw", async () => {
  const reg = new ServerRegistry("/workspace");
  await assert.doesNotReject(() => reg.disposeAll());
});

test("getActiveLanguages is empty after disposeAll on empty registry", async () => {
  const reg = new ServerRegistry("/workspace");
  await reg.disposeAll();
  assert.deepEqual(reg.getActiveLanguages(), []);
});

test("failed spawn leaves no entry in active languages or buffers", async () => {
  const reg = new ServerRegistry("/workspace");
  // Attempt to get a client — will fail if the server binary is not installed.
  const result = await reg.getClientForFile("/workspace/file.rs");
  if (!result.ok) {
    // Spawn failed: registry must remain clean.
    assert.deepEqual(reg.getActiveLanguages(), []);
    assert.equal(reg.getDiagnosticsBuffer("rust"), undefined);
  }
  // If rust-analyzer happens to be installed and init succeeds, clean up.
  await reg.disposeAll();
});

test("getActiveLanguages and getDiagnosticsBuffer are consistent after failed spawn", async () => {
  const reg = new ServerRegistry("/workspace");
  await reg.getClientForFile("/workspace/file.rs");
  const langs = reg.getActiveLanguages();
  for (const lang of langs) {
    // Every active language must have a buffer.
    assert.ok(reg.getDiagnosticsBuffer(lang) !== undefined, `missing buffer for ${lang}`);
  }
  await reg.disposeAll();
});

test("concurrent getOrSpawnClient for same language shares one in-flight promise", async () => {
  const reg = new ServerRegistry("/workspace");
  // Access the private map to observe in-flight state without modifying the API.
  const inProgress = (reg as any).spawnInProgress as Map<string, Promise<unknown>>;

  // Both calls start synchronously. p1 runs until its first internal await
  // (transport.sendRequest inside client.initialize), stores the spawn promise
  // in spawnInProgress, then yields. p2 then runs, sees the in-flight entry,
  // and joins it rather than spawning a second server.
  const p1 = reg.getClientForLanguage("typescript");
  assert.equal(inProgress.size, 1, "expected one in-flight spawn after p1");

  const p2 = reg.getClientForLanguage("typescript");
  assert.equal(inProgress.size, 1, "expected p2 to join the in-flight promise, not create a new one");

  const [r1, r2] = await Promise.all([p1, p2]);

  // The in-flight entry must be cleaned up after both settle.
  assert.equal(inProgress.size, 0, "spawnInProgress must be empty after settlement");

  // Both callers get the same outcome.
  assert.equal(r1.ok, r2.ok);
  if (r1.ok && r2.ok) {
    // If the server happened to start, both calls must share the same client instance.
    assert.strictEqual(r1.value, r2.value, "expected the same LspClient instance");
  }

  await reg.disposeAll();
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

console.log("lsp-registry tests:\n");
run();
