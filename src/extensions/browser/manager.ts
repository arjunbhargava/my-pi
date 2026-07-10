/**
 * Persistent headless Chromium lifecycle for the browser extension.
 *
 * Owns a single browser + page for the session lifetime: cold launch on first
 * use (~500ms-1s), then every subsequent check reuses the warm page (~50-100ms
 * per screenshot). No imports from the pi extension API package.
 */

import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright-core";

import type { Result } from "../../lib/types.js";
import { DESKTOP_VIEWPORT } from "./capture.js";

const NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

/** Exact command that installs the Chromium binary Playwright expects. */
export const CHROMIUM_INSTALL_COMMAND = "node node_modules/playwright-core/cli.js install --with-deps chromium";

/** Smaller headless-shell-only alternative to the full Chromium install. */
export const CHROMIUM_SHELL_INSTALL_COMMAND = "node node_modules/playwright-core/cli.js install --only-shell chromium";

/**
 * Build the actionable error message shown when Chromium cannot be launched
 * because no browser binary is installed.
 *
 * @param cause - The underlying launch failure message from Playwright.
 * @returns A message that includes the exact install command to run.
 */
export function missingBrowserError(cause: string): string {
  return [
    `Failed to launch headless Chromium: ${cause}`,
    `Install it with: ${CHROMIUM_INSTALL_COMMAND}`,
    `(or the smaller headless-only shell: ${CHROMIUM_SHELL_INSTALL_COMMAND})`,
  ].join("\n");
}

/**
 * Whether a launch failure indicates a missing browser binary (as opposed to
 * some other launch problem).
 *
 * @param cause - The launch failure message from Playwright.
 */
export function isMissingBrowserCause(cause: string): boolean {
  const lowered = cause.toLowerCase();
  return lowered.includes("executable doesn't exist") || lowered.includes("playwright install");
}

/**
 * Starts a browser process from launch options. Injectable so lifecycle
 * tests can substitute a deferred fake instead of a real Chromium.
 */
export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

const launchChromium: BrowserLauncher = (options) => chromium.launch(options);

/**
 * Owns one headless Chromium browser and one page, launched lazily on first
 * use and reused across calls until `close()`.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // Concurrent first calls must share one launch instead of leaking a second
  // browser process.
  private launching: Promise<Result<Page>> | null = null;
  private readonly launcher: BrowserLauncher;

  /**
   * @param launcher - Browser process factory; defaults to real Chromium.
   */
  constructor(launcher: BrowserLauncher = launchChromium) {
    this.launcher = launcher;
  }

  /**
   * Launch the browser if needed and return the persistent page. Idempotent:
   * returns the existing live page on subsequent calls.
   *
   * @returns The persistent page, or an actionable error when launch fails.
   */
  async launch(): Promise<Result<Page>> {
    if (this.page && !this.page.isClosed()) return { ok: true, value: this.page };
    if (this.launching) return this.launching;

    this.launching = this.launchFresh();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async launchFresh(): Promise<Result<Page>> {
    const options: LaunchOptions = { headless: true };
    const executablePath = process.env["BROWSER_CHECK_EXECUTABLE"];
    const channel = process.env["BROWSER_CHECK_CHANNEL"];
    if (executablePath) {
      options.executablePath = executablePath;
    } else if (channel) {
      options.channel = channel;
    }

    try {
      this.browser = await this.launcher(options);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      if (isMissingBrowserCause(cause)) {
        return { ok: false, error: missingBrowserError(cause) };
      }
      return { ok: false, error: `Failed to launch headless Chromium: ${cause}` };
    }

    try {
      // deviceScaleFactor 1: retina (2x) screenshots quadruple the pixel count
      // for no gain — vision encoders downsample anyway. The default viewport
      // matches the dual-viewport desktop size so responsive captures leave
      // the page at its default dimensions (see capture.ts).
      this.context = await this.browser.newContext({
        deviceScaleFactor: 1,
        viewport: { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height },
      });
      this.page = await this.context.newPage();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      // closeRefs, not close(): close() awaits `this.launching`, which is this
      // very promise — awaiting it here would deadlock.
      const closed = await this.closeRefs();
      const closeSuffix = closed.ok ? "" : ` (cleanup also failed: ${closed.error})`;
      return { ok: false, error: `Browser launched but opening a page failed: ${cause}${closeSuffix}` };
    }

    return { ok: true, value: this.page };
  }

  /**
   * Navigate the persistent page to a URL, launching the browser first if
   * needed. Waits for DOMContentLoaded, then best-effort network idle.
   *
   * @param url - The URL to navigate to.
   * @returns The navigated page, or an error describing the failure.
   */
  async goto(url: string): Promise<Result<Page>> {
    const launched = await this.launch();
    if (!launched.ok) return launched;
    const page = launched.value;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("timeout")) {
        return { ok: false, error: `Navigation timed out after ${NAVIGATION_TIMEOUT_MS}ms: ${url}` };
      }
      return { ok: false, error: `Navigation failed: ${message}` };
    }

    // Best-effort settle for late-loading assets; pages that stream forever
    // (HMR websockets, analytics) never reach networkidle, so a timeout here
    // is expected and not an error.
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});

    return { ok: true, value: page };
  }

  /**
   * The live persistent page, or null when the browser has not been launched
   * or the page was closed.
   */
  getPage(): Page | null {
    return this.page && !this.page.isClosed() ? this.page : null;
  }

  /**
   * Tear down the browser and forget all references. No-op when never
   * launched; safe to call repeatedly.
   *
   * @returns ok when the browser closed (or was never launched), or the
   * close failure message.
   */
  async close(): Promise<Result<void>> {
    // A close during the first launch must not race past launchFresh():
    // snapshotting `this.browser` before launch assigns it would leave the
    // freshly-launched browser alive after shutdown. Wait for the in-flight
    // launch to settle, then tear down whatever it produced.
    while (this.launching) {
      await this.launching;
    }
    return this.closeRefs();
  }

  private async closeRefs(): Promise<Result<void>> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    if (!browser) return { ok: true, value: undefined };

    try {
      await browser.close();
      return { ok: true, value: undefined };
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to close browser: ${cause}` };
    }
  }
}
