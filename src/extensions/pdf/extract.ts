/**
 * PDF text extraction backed by unpdf (a serverless build of Mozilla's PDF.js).
 * No imports from `@earendil-works/pi-coding-agent` — this module is pure logic
 * so it can be unit-tested in isolation.
 */

import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy, getMeta } from "unpdf";

import { DEFAULT_MAX_CHARS, PAGE_SEPARATOR, type PageRange, type PdfExtractSuccess, type PdfResult } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract text from a PDF file on disk.
 *
 * Loads the document once, reads its metadata and per-page text, selects the
 * requested page range, joins it, and truncates to a character limit.
 *
 * @param options.path      - Path to the PDF file.
 * @param options.firstPage - First page to extract (1-based, inclusive). Defaults to 1.
 * @param options.lastPage  - Last page to extract (1-based, inclusive). Defaults to the last page.
 * @param options.maxChars  - Maximum characters to return (default DEFAULT_MAX_CHARS).
 * @returns Structured result with extracted text and metadata, or an error.
 */
export async function extractPdfText(options: {
  path: string;
  firstPage?: number;
  lastPage?: number;
  maxChars?: number;
}): Promise<PdfResult<PdfExtractSuccess>> {
  const { path, firstPage, lastPage, maxChars = DEFAULT_MAX_CHARS } = options;

  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(path));
  } catch (err) {
    return { ok: false, error: `Cannot read file: ${errorMessage(err)}` };
  }

  let pageTexts: string[];
  let pageCount: number;
  let title: string | undefined;
  try {
    const document = await getDocumentProxy(data);
    const extracted = await extractText(document, { mergePages: false });
    pageCount = extracted.totalPages;
    pageTexts = extracted.text;
    title = await readTitle(document);
  } catch (err) {
    return { ok: false, error: `Failed to parse PDF: ${errorMessage(err)}` };
  }

  if (pageCount === 0) {
    return { ok: false, error: "PDF contains no pages." };
  }

  const range = clampRange(firstPage, lastPage, pageCount);
  const selected = pageTexts.slice(range.first - 1, range.last).join(PAGE_SEPARATOR);

  const truncated = selected.length > maxChars;
  const text = truncated ? selected.slice(0, maxChars) : selected;

  return {
    ok: true,
    value: { path, text, pageCount, extractedPages: range, title, truncated, charCount: text.length },
  };
}

/**
 * Parse a human-supplied page-range string into 1-based bounds.
 *
 * Accepts a single page ("3"), a closed range ("2-5"), an open-ended range
 * ("4-"), or a leading range ("-6"). Returns undefined bounds when the input
 * is undefined or empty, signalling "use the document defaults".
 *
 * @param spec - The raw page-range string, or undefined.
 * @returns Parsed bounds, or an error describing the malformed input.
 */
export function parsePageRange(spec: string | undefined): PdfResult<{ first?: number; last?: number }> {
  if (spec === undefined) return { ok: true, value: {} };
  const trimmed = spec.trim();
  if (trimmed === "") return { ok: true, value: {} };

  const rangeMatch = /^(\d+)?\s*-\s*(\d+)?$/.exec(trimmed);
  if (rangeMatch) {
    const first = rangeMatch[1] !== undefined ? Number(rangeMatch[1]) : undefined;
    const last = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : undefined;
    if (first === undefined && last === undefined) {
      return { ok: false, error: `Invalid page range: "${spec}"` };
    }
    if (first !== undefined && last !== undefined && first > last) {
      return { ok: false, error: `Page range start ${first} is after end ${last}.` };
    }
    return { ok: true, value: { first, last } };
  }

  const single = /^\d+$/.exec(trimmed);
  if (single) {
    const page = Number(trimmed);
    return { ok: true, value: { first: page, last: page } };
  }

  return { ok: false, error: `Invalid page range: "${spec}". Use formats like "3", "2-5", or "4-".` };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Clamp requested page bounds into the document's valid 1..pageCount range.
 * Missing bounds default to the document edges.
 */
function clampRange(firstPage: number | undefined, lastPage: number | undefined, pageCount: number): PageRange {
  const first = Math.min(Math.max(firstPage ?? 1, 1), pageCount);
  const last = Math.min(Math.max(lastPage ?? pageCount, first), pageCount);
  return { first, last };
}

/** Read the document title from PDF metadata, tolerating missing or malformed info. */
async function readTitle(document: Parameters<typeof getMeta>[0]): Promise<string | undefined> {
  try {
    const meta = await getMeta(document);
    const rawTitle = meta.info?.Title;
    if (typeof rawTitle === "string" && rawTitle.trim() !== "") return rawTitle.trim();
  } catch {
    // Metadata is best-effort; absence is not an extraction failure.
  }
  return undefined;
}

/** Normalise an unknown thrown value into a string message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
