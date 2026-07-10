import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Browser } from "playwright-core";

import { BrowserManager, CHROMIUM_INSTALL_COMMAND } from "./manager.js";

interface FakeBrowser {
  browser: Browser;
  isBrowserClosed: () => boolean;
}

function createFakeBrowser(): FakeBrowser {
  let browserClosed = false;
  let pageClosed = false;
  const fakePage = {
    isClosed: () => pageClosed,
  };
  const fakeContext = {
    newPage: async () => fakePage,
  };
  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => {
      browserClosed = true;
      pageClosed = true;
    },
  };
  return {
    browser: fakeBrowser as unknown as Browser,
    isBrowserClosed: () => browserClosed,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("BrowserManager lifecycle", () => {
  it("close() before any launch is an ok no-op", async () => {
    const manager = new BrowserManager(async () => createFakeBrowser().browser);

    const closed = await manager.close();

    assert.equal(closed.ok, true);
    assert.equal(manager.getPage(), null);
  });

  it("launch() launches once and reuses the same page", async () => {
    let launchCount = 0;
    const fake = createFakeBrowser();
    const manager = new BrowserManager(async () => {
      launchCount += 1;
      return fake.browser;
    });

    const first = await manager.launch();
    const second = await manager.launch();

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.ok && second.ok && first.value === second.value, true);
    assert.equal(launchCount, 1);
  });

  it("close() during first launch waits for it and closes the eventual browser", async () => {
    const fake = createFakeBrowser();
    const gate = deferred<Browser>();
    const manager = new BrowserManager(() => gate.promise);

    const launchPromise = manager.launch();
    const closePromise = manager.close();

    gate.resolve(fake.browser);

    const closed = await closePromise;
    const launched = await launchPromise;

    assert.equal(launched.ok, true);
    assert.equal(closed.ok, true);
    assert.equal(manager.getPage(), null);
    assert.equal(fake.isBrowserClosed(), true);
  });

  it("close() after a completed launch closes the browser and is idempotent", async () => {
    const fake = createFakeBrowser();
    const manager = new BrowserManager(async () => fake.browser);

    await manager.launch();
    const firstClose = await manager.close();
    const secondClose = await manager.close();

    assert.equal(firstClose.ok, true);
    assert.equal(secondClose.ok, true);
    assert.equal(fake.isBrowserClosed(), true);
    assert.equal(manager.getPage(), null);
  });

  it("missing-browser launch failures return the actionable install error", async () => {
    const manager = new BrowserManager(async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /tmp/nope");
    });

    const launched = await manager.launch();

    assert.equal(launched.ok, false);
    assert.equal(!launched.ok && launched.error.includes(CHROMIUM_INSTALL_COMMAND), true);
  });
});
