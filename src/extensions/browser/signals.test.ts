import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

import {
  SignalBuffer,
  type ConsoleMessageLike,
  type PageEventSource,
  type RequestLike,
  type ResponseLike,
} from "./signals.js";
import { BrowserManager, missingBrowserError, isMissingBrowserCause } from "./manager.js";

type PageEvent = "console" | "requestfailed" | "response" | "pageerror";

/** Minimal emitter standing in for a Playwright Page in tests. */
class FakePage implements PageEventSource {
  private handlers = new Map<PageEvent, Set<(payload: never) => void>>();

  on(event: PageEvent, handler: (payload: never) => void): unknown {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return this;
  }

  off(event: PageEvent, handler: (payload: never) => void): unknown {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: PageEvent, payload: ConsoleMessageLike | RequestLike | ResponseLike | Error): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (p: typeof payload) => void)(payload);
    }
  }

  handlerCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

function consoleMessage(type: string, text: string): ConsoleMessageLike {
  return { type: () => type, text: () => text };
}

function failedRequest(url: string, errorText: string): RequestLike {
  return { url: () => url, failure: () => ({ errorText }) };
}

function response(url: string, status: number): ResponseLike {
  return { url: () => url, status: () => status };
}

describe("SignalBuffer", () => {
  it("accepts a real Playwright Page (compile-time structural check)", () => {
    const buffer = new SignalBuffer();
    const attachToPage: (page: Page) => void = (page) => buffer.attach(page);
    assert.equal(typeof attachToPage, "function");
  });

  it("drains all buffered signal categories with correct fields", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("console", consoleMessage("error", "Cannot read properties of undefined"));
    page.emit("console", consoleMessage("warning", "deprecated API"));
    page.emit("requestfailed", failedRequest("http://localhost:5173/api", "net::ERR_CONNECTION_REFUSED"));
    page.emit("response", response("http://localhost:5173/missing.png", 404));
    page.emit("pageerror", new Error("boom"));

    const signals = buffer.drain();

    assert.deepEqual(signals.console, [
      { type: "error", text: "Cannot read properties of undefined" },
      { type: "warning", text: "deprecated API" },
    ]);
    assert.deepEqual(signals.failedRequests, [
      { url: "http://localhost:5173/api", failureText: "net::ERR_CONNECTION_REFUSED" },
      { url: "http://localhost:5173/missing.png", status: 404 },
    ]);
    assert.equal(signals.exceptions.length, 1);
    assert.equal(signals.exceptions[0].message, "boom");
    assert.ok(signals.exceptions[0].stack);
  });

  it("returns empty on a second drain immediately after (since-last-check reset)", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("console", consoleMessage("error", "first check"));
    page.emit("pageerror", new Error("first check"));
    buffer.drain();

    const second = buffer.drain();
    assert.deepEqual(second, { console: [], failedRequests: [], exceptions: [] });
  });

  it("keeps accumulating after a drain", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("console", consoleMessage("error", "before"));
    buffer.drain();
    page.emit("console", consoleMessage("error", "after"));

    const signals = buffer.drain();
    assert.deepEqual(signals.console, [{ type: "error", text: "after" }]);
  });

  it("ignores console messages that are neither error nor warning", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("console", consoleMessage("log", "hello"));
    page.emit("console", consoleMessage("info", "fyi"));
    page.emit("console", consoleMessage("debug", "verbose"));

    assert.deepEqual(buffer.drain().console, []);
  });

  it("ignores responses with status below 400", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("response", response("http://localhost:5173/", 200));
    page.emit("response", response("http://localhost:5173/redirect", 302));

    assert.deepEqual(buffer.drain().failedRequests, []);
  });

  it("records a network failure with unknown failure text when failure() is null", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("requestfailed", { url: () => "http://x", failure: () => null });

    assert.deepEqual(buffer.drain().failedRequests, [{ url: "http://x", failureText: "unknown failure" }]);
  });

  it("detach removes listeners and discards buffered signals", () => {
    const page = new FakePage();
    const buffer = new SignalBuffer();
    buffer.attach(page);

    page.emit("console", consoleMessage("error", "buffered before detach"));
    buffer.detach();

    assert.equal(page.handlerCount(), 0);
    page.emit("console", consoleMessage("error", "after detach"));
    assert.deepEqual(buffer.drain(), { console: [], failedRequests: [], exceptions: [] });
  });

  it("re-attach to a new page detaches from the previous one", () => {
    const firstPage = new FakePage();
    const secondPage = new FakePage();
    const buffer = new SignalBuffer();

    buffer.attach(firstPage);
    buffer.attach(secondPage);

    assert.equal(firstPage.handlerCount(), 0);
    firstPage.emit("console", consoleMessage("error", "from stale page"));
    secondPage.emit("console", consoleMessage("error", "from live page"));

    assert.deepEqual(buffer.drain().console, [{ type: "error", text: "from live page" }]);
  });
});

describe("BrowserManager.close", () => {
  it("is an ok no-op when never launched, and idempotent", async () => {
    const manager = new BrowserManager();
    assert.deepEqual(await manager.close(), { ok: true, value: undefined });
    assert.deepEqual(await manager.close(), { ok: true, value: undefined });
    assert.equal(manager.getPage(), null);
  });
});

describe("missingBrowserError", () => {
  it("includes the exact install command", () => {
    const message = missingBrowserError("Executable doesn't exist at /path/chrome");
    assert.ok(message.includes("install --with-deps chromium"));
  });

  it("mentions the smaller headless-only shell option", () => {
    const message = missingBrowserError("Executable doesn't exist at /path/chrome");
    assert.ok(message.includes("--only-shell chromium"));
  });

  it("preserves the underlying cause", () => {
    const message = missingBrowserError("Executable doesn't exist at /path/chrome");
    assert.ok(message.includes("Executable doesn't exist at /path/chrome"));
  });
});

describe("isMissingBrowserCause", () => {
  it("detects Playwright's missing-executable message", () => {
    assert.equal(isMissingBrowserCause("browserType.launch: Executable doesn't exist at /home/u/.cache"), true);
  });

  it("detects the 'playwright install' hint", () => {
    assert.equal(isMissingBrowserCause("Please run the following command: npx playwright install"), true);
  });

  it("rejects unrelated launch failures", () => {
    assert.equal(isMissingBrowserCause("Target page, context or browser has been closed"), false);
  });
});
