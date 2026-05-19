/**
 * Unit tests for SymbolResolver — boundary behaviour without real language servers.
 *
 * These tests verify:
 *   - Methods return empty/null (not errors) when no servers are active
 *   - Methods return empty/null when workspace/symbol finds nothing
 *   - Dotted symbol names are handled (no crash)
 *   - Plain symbol names are handled
 *
 * Run: npx tsx tests/lsp-resolver.test.ts
 */

import { strict as assert } from "node:assert";
import { ServerRegistry } from "../src/extensions/lsp/registry.js";
import { SymbolResolver } from "../src/extensions/lsp/resolver.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeResolver(): { reg: ServerRegistry; resolver: SymbolResolver } {
  const reg = new ServerRegistry("/workspace");
  const resolver = new SymbolResolver(reg, "/workspace");
  return { reg, resolver };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("workspaceSymbols with no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.workspaceSymbols("Foo");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("workspaceSymbols with dotted query and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.workspaceSymbols("MyClass.method");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("workspaceSymbols with unsupported hintPath falls back to all active servers", async () => {
  // No active servers, unsupported extension — still returns ok with empty array.
  const { resolver } = makeResolver();
  const result = await resolver.workspaceSymbols("Foo", "/workspace/schema.json");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("definition with plain symbol and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.definition("someFunction");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("definition with dotted symbol and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.definition("MyClass.method");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("definition with hintPath and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.definition("Foo", "/workspace/main.py");
  // Returns empty array (python server not available, no active servers either)
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("references with plain symbol and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.references("someFunction");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("references with dotted symbol and no active servers returns empty array", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.references("Namespace.Class.method");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, []);
});

test("hover with plain symbol and no active servers returns null", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.hover("someFunction");
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
});

test("hover with dotted symbol and no active servers returns null", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.hover("MyClass.method");
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
});

test("hover with hintPath and no active servers returns null", async () => {
  const { resolver } = makeResolver();
  const result = await resolver.hover("Foo", "/workspace/foo.ts");
  assert.equal(result.ok, true);
  assert.equal(result.value, null);
});

test("all methods are non-throwing for empty symbol string", async () => {
  const { resolver } = makeResolver();
  await assert.doesNotReject(() => resolver.workspaceSymbols(""));
  await assert.doesNotReject(() => resolver.definition(""));
  await assert.doesNotReject(() => resolver.references(""));
  await assert.doesNotReject(() => resolver.hover(""));
});

test("all methods are non-throwing for symbol with only dots", async () => {
  const { resolver } = makeResolver();
  await assert.doesNotReject(() => resolver.definition("..."));
  await assert.doesNotReject(() => resolver.hover(".."));
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

console.log("lsp-resolver tests:\n");
run();
