/**
 * Unit tests for the websearch extension.
 *
 * Covers searchWeb (with mocked fetch) and the web_search tool's execute
 * behaviour (missing API key, API failure, successful formatted output).
 *
 * Run: npx tsx tests/websearch.test.ts
 */

import { strict as assert } from "node:assert";

import { searchWeb } from "../src/extensions/websearch/search.js";
import { registerWebSearchTools } from "../src/extensions/websearch/tools.js";
import { MAX_RESULT_COUNT, TAVILY_API_KEY_ENV } from "../src/extensions/websearch/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockFetch = (url: string, init?: RequestInit) => Promise<Response>;

function withMockedFetch(mockFn: MockFetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureWebSearchTool(): { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- capturing dynamic tool definition
  let captured: any;
  registerWebSearchTools(
    (def) => { captured = def; },
    (props: unknown) => ({ type: "object", properties: props }),
    (opts: unknown) => ({ type: "string", ...opts as object }),
    (inner: unknown) => ({ optional: true, ...(inner as object) }),
    (opts: unknown) => ({ type: "integer", ...opts as object }),
    (opts: unknown) => ({ type: "boolean", ...opts as object }),
  );
  return captured;
}

// ---------------------------------------------------------------------------
// Tests: searchWeb
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

test("searchWeb returns ok:false on network error", async () => {
  await withMockedFetch(async () => { throw new Error("Connection refused"); }, async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("Network error"));
  });
});

test("searchWeb returns ok:false on HTTP error status", async () => {
  await withMockedFetch(async () => mockJsonResponse({ message: "Unauthorized" }, 401), async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("401"));
  });
});

test("searchWeb returns ok:false on malformed JSON", async () => {
  await withMockedFetch(async () => new Response("not-json", { status: 200 }), async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("malformed JSON"));
  });
});

test("searchWeb returns ok:false when response shape is unexpected", async () => {
  await withMockedFetch(async () => mockJsonResponse({ unexpected: true }), async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("unexpected response shape"));
  });
});

test("searchWeb maps content field to snippet", async () => {
  const tavilyResponse = {
    results: [
      { title: "Hello", url: "https://example.com", content: "The snippet text", score: 0.9 },
    ],
  };
  await withMockedFetch(async () => mockJsonResponse(tavilyResponse), async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.results[0].snippet, "The snippet text");
    assert.equal(result.value.results[0].title, "Hello");
    assert.equal(result.value.results[0].url, "https://example.com");
    assert.equal(result.value.results[0].score, 0.9);
  });
});

test("searchWeb includes answer when present", async () => {
  const tavilyResponse = {
    answer: "42 is the answer",
    results: [{ title: "T", url: "https://u.com", content: "s", score: 1 }],
  };
  await withMockedFetch(async () => mockJsonResponse(tavilyResponse), async () => {
    const result = await searchWeb({ query: "test", apiKey: "k" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.answer, "42 is the answer");
  });
});

test("searchWeb caps resultCount at MAX_RESULT_COUNT", async () => {
  let capturedBody: unknown;
  await withMockedFetch(async (_url, init) => {
    capturedBody = JSON.parse(init?.body as string);
    return mockJsonResponse({ results: [] });
  }, async () => {
    await searchWeb({ query: "test", apiKey: "k", resultCount: 999 });
    assert.equal((capturedBody as Record<string, unknown>).max_results, MAX_RESULT_COUNT);
  });
});

test("searchWeb sends Authorization header with api key", async () => {
  let capturedHeaders: Record<string, string> = {};
  await withMockedFetch(async (_url, init) => {
    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
    return mockJsonResponse({ results: [] });
  }, async () => {
    await searchWeb({ query: "test", apiKey: "secret-key" });
    assert.equal(capturedHeaders["authorization"], "Bearer secret-key");
  });
});

// ---------------------------------------------------------------------------
// Tests: web_search tool execute
// ---------------------------------------------------------------------------

test("tool execute returns isError when TAVILY_API_KEY is not set", async () => {
  const tool = captureWebSearchTool();
  const saved = process.env[TAVILY_API_KEY_ENV];
  delete process.env[TAVILY_API_KEY_ENV];
  try {
    const result = await tool.execute("", { query: "hello" }) as Record<string, unknown>;
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes("TAVILY_API_KEY"));
  } finally {
    if (saved !== undefined) process.env[TAVILY_API_KEY_ENV] = saved;
  }
});

test("tool execute returns isError when searchWeb fails", async () => {
  const tool = captureWebSearchTool();
  process.env[TAVILY_API_KEY_ENV] = "test-key";
  try {
    await withMockedFetch(async () => mockJsonResponse({}, 500), async () => {
      const result = await tool.execute("", { query: "hello" }) as Record<string, unknown>;
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.ok(content[0].text.includes("Search failed"));
    });
  } finally {
    delete process.env[TAVILY_API_KEY_ENV];
  }
});

test("tool execute returns formatted output with answer section", async () => {
  const tool = captureWebSearchTool();
  process.env[TAVILY_API_KEY_ENV] = "test-key";
  const tavilyResponse = {
    answer: "Direct answer here",
    results: [
      { title: "Page One", url: "https://one.com", content: "Snippet one", score: 0.95 },
    ],
  };
  try {
    await withMockedFetch(async () => mockJsonResponse(tavilyResponse), async () => {
      const result = await tool.execute("", { query: "something" }) as Record<string, unknown>;
      assert.equal(result.isError, undefined);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0].text;
      assert.ok(text.includes("[Answer]"), "should include answer section header");
      assert.ok(text.includes("Direct answer here"), "should include answer text");
      assert.ok(text.includes("[Results]"), "should include results section header");
      assert.ok(text.includes("Page One"), "should include result title");
      assert.ok(text.includes("https://one.com"), "should include result url");
      assert.ok(text.includes("Snippet one"), "should include result snippet");
      const details = result.details as Record<string, unknown>;
      assert.equal(details.hasAnswer, true);
      assert.equal(details.resultCount, 1);
    });
  } finally {
    delete process.env[TAVILY_API_KEY_ENV];
  }
});

test("tool execute returns formatted output without answer section when absent", async () => {
  const tool = captureWebSearchTool();
  process.env[TAVILY_API_KEY_ENV] = "test-key";
  const tavilyResponse = {
    results: [
      { title: "Page Two", url: "https://two.com", content: "Snippet two", score: 0.8 },
    ],
  };
  try {
    await withMockedFetch(async () => mockJsonResponse(tavilyResponse), async () => {
      const result = await tool.execute("", { query: "something" }) as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0].text;
      assert.ok(!text.includes("[Answer]"), "should not include answer section");
      assert.ok(text.includes("[Results]"), "should include results section");
      const details = result.details as Record<string, unknown>;
      assert.equal(details.hasAnswer, false);
    });
  } finally {
    delete process.env[TAVILY_API_KEY_ENV];
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

console.log("websearch tests:\n");
run();
