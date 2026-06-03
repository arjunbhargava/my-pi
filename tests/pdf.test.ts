/**
 * Unit tests for the pdf extension.
 *
 * Covers parsePageRange (string parsing), extractPdfText (real fixture PDF,
 * page-range selection, truncation, missing file), and the read_pdf tool's
 * execute behaviour (formatted output, invalid range, read failure).
 *
 * Run: npx tsx tests/pdf.test.ts
 */

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { extractPdfText, parsePageRange } from "../src/extensions/pdf/extract.js";
import { registerPdfTools } from "../src/extensions/pdf/tools.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// 3-page PDF: titled "Sample Test Document", pages contain "alpha"/"bravo"/"charlie".
const SAMPLE_PDF = join(here, "fixtures", "sample.pdf");
const MISSING_PDF = join(here, "fixtures", "does-not-exist.pdf");

// ---------------------------------------------------------------------------
// Tool capture helper (mirrors websearch.test.ts)
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function captureReadPdfTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  registerPdfTools(
    (def) => { captured = def as CapturedTool; },
    (props: unknown) => ({ type: "object", properties: props }),
    (opts: unknown) => ({ type: "string", ...(opts as object) }),
    (inner: unknown) => ({ optional: true, ...(inner as object) }),
    (opts: unknown) => ({ type: "integer", ...(opts as object) }),
  );
  if (!captured) throw new Error("read_pdf tool was not registered");
  return captured;
}

// ---------------------------------------------------------------------------
// Test runner (same pattern as websearch.test.ts)
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Tests: parsePageRange
// ---------------------------------------------------------------------------

test("parsePageRange returns empty bounds for undefined and blank input", () => {
  for (const spec of [undefined, "", "   "]) {
    const result = parsePageRange(spec);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.first, undefined);
    assert.equal(result.value.last, undefined);
  }
});

test("parsePageRange parses a single page into equal first/last", () => {
  const result = parsePageRange("3");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.first, 3);
  assert.equal(result.value.last, 3);
});

test("parsePageRange parses a closed range", () => {
  const result = parsePageRange("2-5");
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.first, 2);
  assert.equal(result.value.last, 5);
});

test("parsePageRange parses open-ended and leading ranges", () => {
  const open = parsePageRange("4-");
  assert.ok(open.ok);
  if (open.ok) {
    assert.equal(open.value.first, 4);
    assert.equal(open.value.last, undefined);
  }
  const leading = parsePageRange("-6");
  assert.ok(leading.ok);
  if (leading.ok) {
    assert.equal(leading.value.first, undefined);
    assert.equal(leading.value.last, 6);
  }
});

test("parsePageRange rejects reversed range", () => {
  const result = parsePageRange("5-2");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("after end"));
});

test("parsePageRange rejects non-numeric input", () => {
  const result = parsePageRange("abc");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("Invalid page range"));
});

// ---------------------------------------------------------------------------
// Tests: extractPdfText
// ---------------------------------------------------------------------------

test("extractPdfText reads all pages, page count, and title", async () => {
  const result = await extractPdfText({ path: SAMPLE_PDF });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.pageCount, 3);
  assert.equal(result.value.title, "Sample Test Document");
  assert.equal(result.value.extractedPages.first, 1);
  assert.equal(result.value.extractedPages.last, 3);
  assert.ok(result.value.text.includes("alpha"));
  assert.ok(result.value.text.includes("bravo"));
  assert.ok(result.value.text.includes("charlie"));
  assert.equal(result.value.truncated, false);
});

test("extractPdfText selects a single page", async () => {
  const result = await extractPdfText({ path: SAMPLE_PDF, firstPage: 2, lastPage: 2 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.extractedPages.first, 2);
  assert.equal(result.value.extractedPages.last, 2);
  assert.ok(result.value.text.includes("bravo"));
  assert.ok(!result.value.text.includes("alpha"));
  assert.ok(!result.value.text.includes("charlie"));
});

test("extractPdfText clamps out-of-bounds page requests to the document", async () => {
  const result = await extractPdfText({ path: SAMPLE_PDF, firstPage: 99, lastPage: 200 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.extractedPages.first, 3);
  assert.equal(result.value.extractedPages.last, 3);
  assert.ok(result.value.text.includes("charlie"));
});

test("extractPdfText truncates to maxChars and flags truncation", async () => {
  const result = await extractPdfText({ path: SAMPLE_PDF, maxChars: 5 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.charCount, 5);
  assert.equal(result.value.truncated, true);
});

test("extractPdfText returns ok:false for a missing file", async () => {
  const result = await extractPdfText({ path: MISSING_PDF });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.includes("Cannot read file"));
});

// ---------------------------------------------------------------------------
// Tests: read_pdf tool execute
// ---------------------------------------------------------------------------

test("tool execute returns formatted output with header and metadata", async () => {
  const tool = captureReadPdfTool();
  const result = await tool.execute("", { path: SAMPLE_PDF });
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content[0].text;
  assert.ok(text.includes("[Read PDF:"), "should include header");
  assert.ok(text.includes("Sample Test Document"), "should include title");
  assert.ok(text.includes("3 pages"), "should report full page count");
  assert.ok(text.includes("alpha"), "should include body text");
  const details = result.details as Record<string, unknown>;
  assert.equal(details.pageCount, 3);
  assert.equal(details.truncated, false);
});

test("tool execute reports the selected page range in the header", async () => {
  const tool = captureReadPdfTool();
  const result = await tool.execute("", { path: SAMPLE_PDF, pages: "2" });
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(content[0].text.includes("pages 2-2 of 3"));
});

test("tool execute returns isError on invalid page range", async () => {
  const tool = captureReadPdfTool();
  const result = await tool.execute("", { path: SAMPLE_PDF, pages: "abc" });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(content[0].text.includes("Invalid page range"));
});

test("tool execute returns isError when the file cannot be read", async () => {
  const tool = captureReadPdfTool();
  const result = await tool.execute("", { path: MISSING_PDF });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(content[0].text.includes("PDF read failed"));
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
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  \u2717 ${t.name}`);
      console.log(`    ${err instanceof Error ? err.stack : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("pdf tests:\n");
run();
