/**
 * Browserbase cloud browser client for JS-rendered page content extraction.
 * No imports from `@mariozechner/pi-coding-agent`.
 */

import { chromium, type Browser } from "playwright-core";
import { Browserbase } from "@browserbasehq/sdk";

import { DEFAULT_BROWSE_TIMEOUT_MS, DEFAULT_FETCH_MAX_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for browsing a URL via Browserbase cloud browser. */
export interface BrowsePageOptions {
  /** URL to navigate to. */
  url: string;
  /** Browserbase API key. */
  apiKey: string;
  /** Max characters to extract. Default 6000. */
  maxChars?: number;
  /** CSS selector to extract text from. Default "body". Use "main" or "article" to skip nav/footer. */
  extractSelector?: string;
  /** CSS selector to wait for before extracting. If omitted, waits for network idle. */
  waitForSelector?: string;
  /** Route through residential proxies for Cloudflare bypass. Default true. */
  useProxy?: boolean;
  /** Auto-solve reCAPTCHA/hCaptcha. Default true. */
  solveCaptchas?: boolean;
  /** Navigation timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

/** Successful browse result. */
export interface BrowsePageSuccess {
  /** The URL that was browsed. */
  url: string;
  /** Extracted text content. */
  text: string;
  /** Whether text was truncated to maxChars. */
  truncated: boolean;
  /** Number of characters in the returned text. */
  charCount: number;
  /** Browserbase session ID — links to recording at https://browserbase.com/sessions/<id>. */
  sessionId: string;
}

/** Structured result for browsePageText. */
export type BrowsePageResult =
  | { ok: true; value: BrowsePageSuccess }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Browse a URL using a Browserbase cloud browser and extract text content.
 *
 * Creates a remote browser session, navigates to the URL, waits for JS to
 * render, extracts text from the specified selector, and closes the session.
 * Handles Cloudflare protection and CAPTCHAs when proxy and captcha options
 * are enabled.
 *
 * @param options.url - URL to navigate to.
 * @param options.apiKey - Browserbase API key.
 * @param options.maxChars - Max characters to extract (default 6000).
 * @param options.extractSelector - CSS selector to extract text from (default "body").
 * @param options.waitForSelector - CSS selector to wait for before extracting.
 * @param options.useProxy - Route through residential proxies (default true).
 * @param options.solveCaptchas - Auto-solve CAPTCHAs (default true).
 * @param options.timeoutMs - Navigation timeout in milliseconds (default 30000).
 * @returns Structured result with extracted text, or error.
 */
export async function browsePageText(options: BrowsePageOptions): Promise<BrowsePageResult> {
  const {
    url,
    apiKey,
    maxChars = DEFAULT_FETCH_MAX_CHARS,
    extractSelector,
    waitForSelector,
    useProxy = true,
    solveCaptchas = true,
    timeoutMs = DEFAULT_BROWSE_TIMEOUT_MS,
  } = options;

  let browser: Browser | undefined;

  try {
    const bb = new Browserbase({ apiKey });

    let sessionId: string;
    let connectUrl: string;
    try {
      const session = await bb.sessions.create({
        proxies: useProxy,
        browserSettings: { solveCaptchas, recordSession: true },
      });
      sessionId = session.id;
      connectUrl = session.connectUrl;
    } catch (err) {
      return { ok: false, error: `Browserbase session failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
      browser = await chromium.connectOverCDP(connectUrl);
    } catch (err) {
      return { ok: false, error: `Browser connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const page = browser.contexts()[0].pages()[0];

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10_000 });
    } else {
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    }

    let raw = await page.evaluate<string | null, string>(
      (sel) => {
        const el = document.querySelector(sel);
        return el instanceof HTMLElement ? el.innerText : null;
      },
      extractSelector ?? "body",
    );

    if (raw === null && extractSelector !== undefined) {
      raw = await page.evaluate<string | null, string>(
        (sel) => {
          const el = document.querySelector(sel);
          return el instanceof HTMLElement ? el.innerText : null;
        },
        "body",
      );
    }

    if (raw === null) {
      return { ok: false, error: "No content found on page" };
    }

    const normalized = normalizeText(raw);
    const truncated = normalized.length > maxChars;
    const text = truncated ? normalized.slice(0, maxChars) : normalized;

    return {
      ok: true,
      value: { url, text, truncated, charCount: text.length, sessionId },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.message.toLowerCase().includes("timeout")) {
      return { ok: false, error: `Navigation timed out after ${timeoutMs}ms: ${url}` };
    }
    return { ok: false, error: `Browse failed: ${msg}` };
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize extracted innerText: collapse whitespace, limit blank lines.
 *
 * Exported for testing.
 */
export function normalizeText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
