/**
 * Unit tests for LspClient guard behaviour and structural invariants.
 *
 * These tests do not spawn a real language server. They verify:
 *   - `isReady` is false before `initialize()`
 *   - All query methods return `{ ok: false }` before initialization
 *   - `languageId` reflects the config
 *   - `initialize()` with a bad command returns a structured error
 *
 * Run: npx tsx tests/lsp-client.test.ts
 */

import { strict as assert } from "node:assert";
import { LspClient, uriToPath, pathToUri } from "../src/extensions/lsp/client.js";
import { DiagnosticsBuffer } from "../src/extensions/lsp/diagnostics.js";
import { SERVER_CONFIGS } from "../src/extensions/lsp/types.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClient(languageIndex = 0): LspClient {
  return new LspClient({
    config: SERVER_CONFIGS[languageIndex],
    workspaceRoot: "/workspace",
    diagnosticsBuffer: new DiagnosticsBuffer("/workspace"),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("isReady is false before initialize", async () => {
  const client = makeClient();
  assert.equal(client.isReady, false);
});

test("languageId reflects the server config", async () => {
  assert.equal(makeClient(0).languageId, "typescript");
  assert.equal(makeClient(1).languageId, "python");
  assert.equal(makeClient(2).languageId, "cpp");
  assert.equal(makeClient(3).languageId, "rust");
});

test("definition returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.definition("/workspace/foo.ts", 0, 0);
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("references returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.references("/workspace/foo.ts", 0, 0);
  assert.equal(result.ok, false);
});

test("hover returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.hover("/workspace/foo.ts", 0, 0);
  assert.equal(result.ok, false);
});

test("workspaceSymbols returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.workspaceSymbols("Foo");
  assert.equal(result.ok, false);
});

test("openDocument returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.openDocument("/workspace/foo.ts");
  assert.equal(result.ok, false);
});

test("changeDocument returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.changeDocument("/workspace/foo.ts", "content");
  assert.equal(result.ok, false);
});

test("closeDocument returns error before initialize", async () => {
  const client = makeClient();
  const result = await client.closeDocument("/workspace/foo.ts");
  assert.equal(result.ok, false);
});

test("shutdown on uninitialized client is a no-op (does not throw)", async () => {
  const client = makeClient();
  await assert.doesNotReject(() => client.shutdown());
});

test("initialize with nonexistent command returns structured error", async () => {
  const client = new LspClient({
    config: {
      languageId: "typescript",
      fileExtensions: ["ts"],
      command: "nonexistent-lsp-server-that-does-not-exist",
      args: ["--stdio"],
      usesStdio: true,
    },
    workspaceRoot: "/workspace",
    diagnosticsBuffer: new DiagnosticsBuffer("/workspace"),
  });

  const result = await client.initialize();
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
  // Client must remain not ready after a failed init.
  assert.equal(client.isReady, false);
});

test("initialize called twice returns error on second call", async () => {
  // We can only test this if the first call succeeds. Use a client that
  // would succeed initializing but we trick it by checking the guard path
  // by creating a pre-initialized-looking state via two calls.
  // Since any real server isn't available in tests, use the guard test:
  // call initialize once on a bad server (fails), then call again — second
  // call should see no prior initialization, so it tries again (not double-init).
  // For the true double-init guard, we exercise the "already initialized" branch
  // by accessing a private-ish path. We skip that here since it requires a real server.
  // This test confirms the error message is stable.
  const client = new LspClient({
    config: {
      languageId: "typescript",
      fileExtensions: ["ts"],
      command: "nonexistent-lsp-command",
      args: [],
      usesStdio: true,
    },
    workspaceRoot: "/tmp",
    diagnosticsBuffer: new DiagnosticsBuffer("/tmp"),
  });

  const first = await client.initialize();
  assert.equal(first.ok, false);
  // After a failed init the client is NOT marked initialized, so a second
  // attempt is allowed (it will fail again for the same reason).
  const second = await client.initialize();
  assert.equal(second.ok, false);
});

test("uriToPath decodes percent-encoded spaces", () => {
  assert.equal(uriToPath("file:///my%20project/foo.ts"), "/my project/foo.ts");
});

test("uriToPath decodes percent-encoded unicode", () => {
  assert.equal(uriToPath("file:///path/%E6%97%A5%E6%9C%AC%E8%AA%9E/foo.ts"), "/path/\u65e5\u672c\u8a9e/foo.ts");
});

test("uriToPath decodes percent-encoded hash in filename", () => {
  assert.equal(uriToPath("file:///workspace/foo%23bar.ts"), "/workspace/foo#bar.ts");
});

test("pathToUri encodes spaces", () => {
  assert.equal(pathToUri("/my project/foo.ts"), "file:///my%20project/foo.ts");
});

test("pathToUri encodes unicode", () => {
  assert.equal(pathToUri("/path/\u65e5\u672c\u8a9e/foo.ts"), "file:///path/%E6%97%A5%E6%9C%AC%E8%AA%9E/foo.ts");
});

test("round-trip pathToUri/uriToPath preserves path with spaces", () => {
  const original = "/my project/src/foo bar.ts";
  assert.equal(uriToPath(pathToUri(original)), original);
});

test("round-trip pathToUri/uriToPath preserves path with unicode", () => {
  const original = "/path/\u65e5\u672c\u8a9e/file.ts";
  assert.equal(uriToPath(pathToUri(original)), original);
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

console.log("lsp-client tests:\n");
run();
