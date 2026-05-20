/**
 * Unit tests for JsonRpcTransport guard behaviour.
 *
 * These tests spawn real child processes but exercise only the transport
 * layer — no LSP semantics required.
 *
 * Run: npx tsx tests/lsp-transport.test.ts
 */

import { strict as assert } from "node:assert";
import { JsonRpcTransport } from "../src/extensions/lsp/transport.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("sendNotification after dispose does not throw", async () => {
  // `cat` stays alive until its stdin is closed, giving us a controllable target.
  const transport = new JsonRpcTransport({
    command: "cat",
    args: [],
    cwd: process.cwd(),
  });

  transport.dispose();
  assert.equal(transport.isAlive, false);

  // Must be silent — no EPIPE, no unhandled error, no throw.
  assert.doesNotThrow(() => transport.sendNotification("exit"));
});

test("sendRequest after dispose rejects with structured error, not EPIPE", async () => {
  const transport = new JsonRpcTransport({
    command: "cat",
    args: [],
    cwd: process.cwd(),
  });

  transport.dispose();

  await assert.rejects(
    () => transport.sendRequest("initialize", {}, 100),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("not alive"),
        `expected "not alive" in message, got: ${err.message}`,
      );
      return true;
    },
  );
});

test("isAlive is false after process exits naturally", async () => {
  // `true` exits immediately with code 0.
  const transport = new JsonRpcTransport({
    command: "true",
    args: [],
    cwd: process.cwd(),
  });

  // Wait for the exit event to propagate via the event loop.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  assert.equal(transport.isAlive, false);

  // sendNotification must still be safe after natural exit.
  assert.doesNotThrow(() => transport.sendNotification("exit"));
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

console.log("lsp-transport tests:\n");
run();
