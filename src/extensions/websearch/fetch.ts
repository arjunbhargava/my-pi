/**
 * URL fetcher with HTML-to-text extraction for the websearch extension.
 * No imports from `@mariozechner/pi-coding-agent`.
 */

import { DEFAULT_FETCH_MAX_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Successful page-fetch result. */
export interface FetchPageSuccess {
  url: string;
  text: string;
  truncated: boolean;
  charCount: number;
}

/** Structured result for fetchPageText. */
export type FetchPageResult =
  | { ok: true; value: FetchPageSuccess }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; PiAgent/1.0)";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and extract its readable text content.
 *
 * Downloads the page, strips HTML tags/scripts/styles/nav elements,
 * collapses whitespace, and truncates to maxChars.
 *
 * @param options.url - URL to fetch.
 * @param options.maxChars - Maximum characters to return (default DEFAULT_FETCH_MAX_CHARS).
 * @param options.signal - Optional AbortSignal for cancellation.
 * @returns Structured result with extracted text, or error.
 */
export async function fetchPageText(options: {
  url: string;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<FetchPageResult> {
  const { url, maxChars = DEFAULT_FETCH_MAX_CHARS, signal } = options;
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combinedSignal = signal ? mergeSignals(timeoutSignal, signal) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: combinedSignal,
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const isPlain = contentType.includes("text/plain");

  if (!isHtml && !isPlain) {
    const bare = contentType.split(";")[0].trim();
    return { ok: false, error: `Unsupported content type: ${bare}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return { ok: false, error: `Failed to read response body: ${err instanceof Error ? err.message : String(err)}` };
  }

  const extracted = isHtml ? extractTextFromHtml(body) : body;
  const truncated = extracted.length > maxChars;
  const text = truncated ? extracted.slice(0, maxChars) : extracted;

  return { ok: true, value: { url, text, truncated, charCount: text.length } };
}

/**
 * Extract readable text from an HTML string.
 *
 * Removes script/style/nav/header/footer elements, strips remaining HTML tags,
 * decodes common HTML entities, and collapses whitespace.
 */
export function extractTextFromHtml(html: string): string {
  let text = html;

  // Remove block elements whose content is not user-readable prose.
  for (const tag of ["script", "style", "nav", "header", "footer"]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // Emit paragraph breaks for block-level closing tags.
  text = text.replace(/<\/(p|h[1-6])>/gi, "\n\n");

  // Emit single newlines for inline-ish breaks and list items.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(div|li)>/gi, "\n");

  // Strip all remaining tags.
  text = text.replace(/<[^>]*>/g, "");

  // Decode common HTML entities.
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Collapse runs of horizontal whitespace on each line, then normalise
  // multiple blank lines to at most two (preserving paragraph breaks).
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Combine two AbortSignals so that the resulting signal aborts when either
 * input aborts. Uses AbortController rather than AbortSignal.any to avoid
 * requiring a lib target that includes AbortSignal.any.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
  } else {
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
