/**
 * Unit tests for browse.ts — normalizeText, browsePageText error paths,
 * and the web_browse tool's execute handler.
 *
 * The normalizeText and missing-API-key tests are pure unit tests.
 * The browsePageText-with-empty-apiKey test makes a real network call to
 * Browserbase (returns 401); it validates that our catch block produces a
 * clean structured error.
 *
 * Integration tests for real Browserbase sessions are in tests/e2e/
 * (manual, requires BROWSERBASE_API_KEY).
 *
 * Run: npx tsx tests/websearch-browse.test.ts
 */

import { strict as assert } from "node:assert";

import { normalizeText, browsePageText } from "../src/extensions/websearch/browse.js";
import { registerWebSearchTools } from "../src/extensions/websearch/tools.js";
import { BROWSERBASE_API_KEY_ENV } from "../src/extensions/websearch/types.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureWebBrowseTool(): { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } {
  const captured: Record<string, unknown> = {};
  registerWebSearchTools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capturing dynamic tool definition
    (def: any) => { if (def.name === "web_browse") Object.assign(captured, def); },
    (props: unknown) => ({ type: "object", properties: props }),
    (opts: unknown) => ({ type: "string", ...opts as object }),
    (inner: unknown) => ({ optional: true, ...(inner as object) }),
    (opts: unknown) => ({ type: "integer", ...opts as object }),
    (opts: unknown) => ({ type: "boolean", ...opts as object }),
  );
  return captured as { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// Tests: normalizeText
// ---------------------------------------------------------------------------

test("normalizeText collapses triple newlines to double", () => {
  const input = "line one\n\n\nline two\n\n\n\nline three";
  const result = normalizeText(input);
  assert.ok(!result.includes("\n\n\n"), `got: ${JSON.stringify(result)}`);
  assert.ok(result.includes("line one\n\nline two\n\nline three"), `got: ${JSON.stringify(result)}`);
});

test("normalizeText collapses tab runs and spaces to single space", () => {
  const input = "word\t\t lots\t of   spaces";
  const result = normalizeText(input);
  assert.equal(result, "word lots of spaces");
});

test("normalizeText trims leading and trailing whitespace", () => {
  const input = "   \n  hello world  \n   ";
  const result = normalizeText(input);
  assert.equal(result, "hello world");
});

test("normalizeText handles empty string", () => {
  assert.equal(normalizeText(""), "");
});

test("normalizeText preserves exactly two consecutive newlines", () => {
  const input = "para one\n\npara two";
  assert.equal(normalizeText(input), "para one\n\npara two");
});

test("normalizeText strips trailing spaces from each line", () => {
  const input = "line one   \nline two   ";
  const result = normalizeText(input);
  assert.equal(result, "line one\nline two");
});

// ---------------------------------------------------------------------------
// Tests: web_browse tool execute — missing API key
// ---------------------------------------------------------------------------

test("tool execute returns isError when BROWSERBASE_API_KEY is not set", async () => {
  const tool = captureWebBrowseTool();
  const saved = process.env[BROWSERBASE_API_KEY_ENV];
  delete process.env[BROWSERBASE_API_KEY_ENV];
  try {
    const result = await tool.execute("", { url: "https://example.com" }) as Record<string, unknown>;
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes("BROWSERBASE_API_KEY"), `got: ${content[0].text}`);
  } finally {
    if (saved !== undefined) process.env[BROWSERBASE_API_KEY_ENV] = saved;
  }
});

// ---------------------------------------------------------------------------
// Tests: browsePageText — empty apiKey (real network call, expects 401/auth error)
// ---------------------------------------------------------------------------

test("browsePageText returns ok:false when apiKey is empty", async () => {
  const result = await browsePageText({ url: "https://example.com", apiKey: "" });
  assert.equal(result.ok, false, "expected ok:false with an empty apiKey");
  assert.ok(!result.ok && result.error.length > 0, "expected a non-empty error message");
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

console.log("websearch-browse tests:\n");
run();
