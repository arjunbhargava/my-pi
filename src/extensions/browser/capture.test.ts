import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

import {
  capture,
  DESKTOP_VIEWPORT,
  MAX_IMAGE_WIDTH_PX,
  MOBILE_VIEWPORT,
  type CapturePage,
  type LocatorLike,
} from "./capture.js";

/** Build a buffer with a valid PNG signature and IHDR width/height fields. */
function pngBuffer(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Fake page whose screenshots are PNGs sized to the current viewport, so
 * tests can assert per-shot dimensions without a real browser.
 */
class FakePage implements CapturePage {
  screenshotCalls: Array<{ fullPage?: boolean } | undefined> = [];
  viewportCalls: ViewportSize[] = [];
  locatorSelectors: string[] = [];
  currentViewport: ViewportSize = { width: 1280, height: 720 };
  elementPng: Buffer = pngBuffer(200, 100);
  elementError: Error | null = null;

  async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
    this.screenshotCalls.push(options);
    return pngBuffer(this.currentViewport.width, this.currentViewport.height);
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    this.viewportCalls.push(size);
    this.currentViewport = size;
  }

  locator(selector: string): LocatorLike {
    this.locatorSelectors.push(selector);
    return {
      screenshot: async () => {
        if (this.elementError) throw this.elementError;
        return this.elementPng;
      },
    };
  }
}

describe("capture", () => {
  it("accepts a real Playwright Page (compile-time structural check)", () => {
    const captureFromPage: (page: Page) => ReturnType<typeof capture> = (page) => capture(page);
    assert.equal(typeof captureFromPage, "function");
  });

  it("defaults to exactly one viewport image with no fullPage and no selector", async () => {
    const page = new FakePage();
    const result = await capture(page);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].label, "viewport");
    assert.equal(result.value[0].widthPx, 1280);
    assert.equal(result.value[0].heightPx, 720);
    assert.deepEqual(page.screenshotCalls, [undefined]);
    assert.deepEqual(page.locatorSelectors, []);
    assert.deepEqual(page.viewportCalls, []);
  });

  it("returns base64 of the raw PNG bytes", async () => {
    const page = new FakePage();
    const result = await capture(page);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0].base64, pngBuffer(1280, 720).toString("base64"));
  });

  it("passes { fullPage: true } to page.screenshot and labels the image fullPage", async () => {
    const page = new FakePage();
    const result = await capture(page, { fullPage: true });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0].label, "fullPage");
    assert.deepEqual(page.screenshotCalls, [{ fullPage: true }]);
  });

  it("crops to the element via page.locator(selector).screenshot()", async () => {
    const page = new FakePage();
    page.elementPng = pngBuffer(320, 48);
    const result = await capture(page, { selector: "#hero" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].label, "element:#hero");
    assert.equal(result.value[0].widthPx, 320);
    assert.equal(result.value[0].heightPx, 48);
    assert.deepEqual(page.locatorSelectors, ["#hero"]);
    assert.deepEqual(page.screenshotCalls, []);
  });

  it("returns ok:false with a readable message when the element screenshot fails", async () => {
    const page = new FakePage();
    page.elementError = new Error('Timeout 5000ms exceeded waiting for locator("#missing")');
    const result = await capture(page, { selector: "#missing" });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("element:#missing"));
    assert.ok(result.error.includes("Timeout 5000ms exceeded"));
  });

  it("responsive mode sets 390 then 1440 viewports and returns two labeled images in order", async () => {
    const page = new FakePage();
    const result = await capture(page, { viewports: "responsive" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(page.viewportCalls, [
      { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height },
      { width: DESKTOP_VIEWPORT.width, height: DESKTOP_VIEWPORT.height },
    ]);
    assert.deepEqual(page.viewportCalls, [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]);
    assert.deepEqual(
      result.value.map((image) => image.label),
      ["390px", "1440px"],
    );
    assert.deepEqual(
      result.value.map((image) => image.widthPx),
      [390, 1440],
    );
  });

  it("marks images wider than 1500px for downscale to exactly 1500", async () => {
    const page = new FakePage();
    page.currentViewport = { width: 2000, height: 900 };
    const result = await capture(page);

    assert.equal(MAX_IMAGE_WIDTH_PX, 1500);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0].widthPx, 2000);
    assert.equal(result.value[0].downscaleToWidthPx, 1500);
  });

  it("leaves downscaleToWidthPx unset for images at or under 1500px", async () => {
    const page = new FakePage();
    page.currentViewport = { width: 1500, height: 900 };
    const result = await capture(page);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0].downscaleToWidthPx, undefined);
  });

  it("rejects responsive mode combined with selector or fullPage", async () => {
    const page = new FakePage();

    const withSelector = await capture(page, { viewports: "responsive", selector: "#x" });
    assert.equal(withSelector.ok, false);

    const withFullPage = await capture(page, { viewports: "responsive", fullPage: true });
    assert.equal(withFullPage.ok, false);

    assert.deepEqual(page.viewportCalls, []);
    assert.deepEqual(page.screenshotCalls, []);
  });

  it("rejects selector combined with fullPage", async () => {
    const page = new FakePage();
    const result = await capture(page, { selector: "#x", fullPage: true });

    assert.equal(result.ok, false);
    assert.deepEqual(page.screenshotCalls, []);
    assert.deepEqual(page.locatorSelectors, []);
  });

  it("returns ok:false when the screenshot is not a valid PNG", async () => {
    const page = new FakePage();
    page.elementPng = Buffer.from("not a png");
    const result = await capture(page, { selector: "#hero" });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error.includes("valid PNG"));
  });
});
