/**
 * Unit tests for fetch.ts — extractTextFromHtml and fetchPageText.
 *
 * Run: npx tsx tests/websearch-fetch.test.ts
 */

import { strict as assert } from "node:assert";

import { extractTextFromHtml, fetchPageText } from "../src/extensions/websearch/fetch.js";

// ---------------------------------------------------------------------------
// Test runner (same pattern as websearch.test.ts)
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

type MockFetch = (url: string, init?: RequestInit) => Promise<Response>;

function withMockedFetch(mockFn: MockFetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// extractTextFromHtml
// ---------------------------------------------------------------------------

test("removes <script> blocks including their content", () => {
  const html = '<p>Hello</p><script>alert("bad")</script><p>World</p>';
  const text = extractTextFromHtml(html);
  assert.ok(!text.includes("alert"), "script content should be removed");
  assert.ok(text.includes("Hello"), "prose content should remain");
  assert.ok(text.includes("World"), "prose content after script should remain");
});

test("removes <style> blocks including their content", () => {
  const html = "<p>Text</p><style>.foo { color: red; }</style>";
  const text = extractTextFromHtml(html);
  assert.ok(!text.includes("color"), "style content should be removed");
  assert.ok(text.includes("Text"));
});

test("removes <nav>, <header>, <footer> blocks", () => {
  const html = "<nav>Menu items</nav><main>Main content</main><footer>Copyright</footer>";
  const text = extractTextFromHtml(html);
  assert.ok(!text.includes("Menu items"), "nav content should be removed");
  assert.ok(!text.includes("Copyright"), "footer content should be removed");
  assert.ok(text.includes("Main content"));
});

test("removes block-level elements with attributes on script tag", () => {
  const html = '<script type="text/javascript" defer>var x = 1;</script><p>Keep</p>';
  const text = extractTextFromHtml(html);
  assert.ok(!text.includes("var x"), "script with attributes should be fully removed");
  assert.ok(text.includes("Keep"));
});

test("replaces </p> and </h1>-</h6> with double newlines", () => {
  const html = "<p>First para</p><p>Second para</p><h2>Heading</h2>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("First para\n\nSecond para"), "paragraphs should be separated by blank line");
  assert.ok(text.includes("Heading"), "heading text should remain");
});

test("replaces <br> and <br/> with newlines", () => {
  const html = "Line one<br>Line two<br/>Line three";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("Line one\nLine two\nLine three"), `got: ${JSON.stringify(text)}`);
});

test("replaces </div> and </li> with newlines", () => {
  const html = "<ul><li>item one</li><li>item two</li></ul>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("item one\nitem two"), `got: ${JSON.stringify(text)}`);
});

test("decodes common HTML entities", () => {
  const html = "<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("&"), "& entity");
  assert.ok(text.includes("<"), "< entity");
  assert.ok(text.includes(">"), "> entity");
  assert.ok(text.includes('"'), "quote entity");
  assert.ok(text.includes("'"), "apos entity");
});

test("collapses runs of horizontal whitespace", () => {
  const html = "<p>word   lots    of    spaces</p>";
  const text = extractTextFromHtml(html);
  assert.equal(text, "word lots of spaces");
});

test("collapses more than two consecutive newlines to two", () => {
  const html = "<p>A</p><p>B</p><p>C</p>";
  const text = extractTextFromHtml(html);
  assert.ok(!text.includes("\n\n\n"), "should not have triple newlines");
});

test("handles deeply nested content", () => {
  const html = "<div><div><div><p>Deep text</p></div></div></div>";
  const text = extractTextFromHtml(html);
  assert.ok(text.includes("Deep text"), "deeply nested text should be extracted");
});

test("trims leading and trailing whitespace", () => {
  const html = "   <p>Trimmed</p>   ";
  const text = extractTextFromHtml(html);
  assert.equal(text, "Trimmed");
});

// ---------------------------------------------------------------------------
// fetchPageText
// ---------------------------------------------------------------------------

test("fetchPageText extracts text from HTML response", async () => {
  await withMockedFetch(async () => {
    return new Response("<html><body><p>Hello world</p></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.value.text.includes("Hello world"));
    assert.equal(result.value.url, "https://example.com");
    assert.equal(result.value.truncated, false);
  });
});

test("fetchPageText truncates when text exceeds maxChars", async () => {
  const longContent = "x".repeat(10_000);
  await withMockedFetch(async () => {
    return new Response(`<p>${longContent}</p>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com", maxChars: 100 });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
    assert.equal(result.value.charCount, 100);
    assert.equal(result.value.text.length, 100);
  });
});

test("fetchPageText returns ok:false on non-2xx status", async () => {
  await withMockedFetch(async () => {
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("404"));
  });
});

test("fetchPageText returns ok:false for unsupported content type", async () => {
  await withMockedFetch(async () => {
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("Unsupported content type"));
    assert.ok(!result.ok && result.error.includes("application/json"));
  });
});

test("fetchPageText handles plain text content type directly", async () => {
  await withMockedFetch(async () => {
    return new Response("Plain text content", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.text, "Plain text content");
  });
});

test("fetchPageText returns ok:false on network failure", async () => {
  await withMockedFetch(async () => {
    throw new Error("ECONNREFUSED");
  }, async () => {
    const result = await fetchPageText({ url: "https://example.com" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("Network error"));
    assert.ok(!result.ok && result.error.includes("ECONNREFUSED"));
  });
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

console.log("websearch-fetch tests:\n");
run();
