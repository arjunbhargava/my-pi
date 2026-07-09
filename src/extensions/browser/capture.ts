/**
 * Screenshot capture for the persistent browser page.
 *
 * Returns raw PNG base64 plus natural pixel dimensions. The actual downscale
 * to {@link MAX_IMAGE_WIDTH_PX} is NOT done here: AGENTS.md forbids importing
 * the pi extension API package outside the extension entry point, and
 * pi's `resizeImage` helper lives in that package. This module instead marks
 * every over-wide image with `downscaleToWidthPx` so the tool wiring in the
 * entry point can perform the resize. No imports from the pi extension API
 * package.
 */

import type { Result } from "../../lib/types.js";

/**
 * Vision encoders downsample anyway; images wider than this just burn tokens.
 * The tool wiring must downscale any image whose `downscaleToWidthPx` is set.
 */
export const MAX_IMAGE_WIDTH_PX = 1500;

/** Mobile viewport for dual-viewport capture (iPhone 14-class: 390x844). */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/**
 * Desktop viewport for dual-viewport capture (1440x900). Also the default
 * viewport of the persistent context (see manager.ts), so dual-viewport
 * capture — which ends on the desktop pass — leaves the page at its default
 * size and no restore step is needed.
 */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

/** Bound the wait for an element to appear before an element crop fails. */
const ELEMENT_SCREENSHOT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Options and output shapes
// ---------------------------------------------------------------------------

/**
 * Capture options. Modes are mutually exclusive: the default is a single
 * viewport screenshot; `fullPage`, `selector`, and `viewports` each select a
 * different mode and cannot be combined.
 */
export interface CaptureOptions {
  /** Capture the full scrollable page instead of just the viewport. */
  fullPage?: boolean;
  /** Crop to the element matching this CSS selector. */
  selector?: string;
  /** "responsive": capture at 390px and 1440px widths in one call. */
  viewports?: "responsive";
}

/** One captured screenshot with its natural (pre-resize) dimensions. */
export interface CapturedImage {
  /** "viewport", "fullPage", "element:<selector>", "390px", or "1440px". */
  label: string;
  /** Raw PNG, base64-encoded. */
  base64: string;
  /** Natural pixel width as captured (before any downscale). */
  widthPx: number;
  /** Natural pixel height as captured (before any downscale). */
  heightPx: number;
  /**
   * Set when `widthPx` exceeds {@link MAX_IMAGE_WIDTH_PX}: the width the
   * caller must downscale the image to before returning it to the model.
   */
  downscaleToWidthPx?: number;
}

// ---------------------------------------------------------------------------
// Page surface (structural subset of Playwright's Page)
// ---------------------------------------------------------------------------

/** Structural subset of Playwright's Locator used for element crops. */
export interface LocatorLike {
  screenshot(options?: { timeout?: number }): Promise<Buffer>;
}

/**
 * Structural subset of Playwright's Page used by capture.
 * A real `Page` satisfies this; tests can pass a plain fake.
 */
export interface CapturePage {
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  locator(selector: string): LocatorLike;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture one or more screenshots of the page according to `options`.
 *
 * @param page - The persistent page (or structural equivalent).
 * @param options - Mode selection; defaults to a single viewport screenshot.
 * @returns Labeled images with natural dimensions, or a readable error for
 * expected failures (element not found, invalid option combination).
 */
export async function capture(
  page: CapturePage,
  options: CaptureOptions = {},
): Promise<Result<CapturedImage[]>> {
  const conflict = findOptionConflict(options);
  if (conflict) return { ok: false, error: conflict };

  if (options.viewports === "responsive") return captureResponsive(page);

  const single = await captureOne(page, options, labelFor(options));
  if (!single.ok) return single;
  return { ok: true, value: [single.value] };
}

function findOptionConflict(options: CaptureOptions): string | null {
  if (options.viewports === "responsive" && (options.selector || options.fullPage)) {
    return 'viewports: "responsive" cannot be combined with selector or fullPage';
  }
  if (options.selector && options.fullPage) {
    return "selector and fullPage cannot be combined; an element crop has no full-page variant";
  }
  return null;
}

function labelFor(options: CaptureOptions): string {
  if (options.selector) return `element:${options.selector}`;
  return options.fullPage ? "fullPage" : "viewport";
}

async function captureOne(
  page: CapturePage,
  options: CaptureOptions,
  label: string,
): Promise<Result<CapturedImage>> {
  let png: Buffer;
  try {
    if (options.selector) {
      png = await page.locator(options.selector).screenshot({ timeout: ELEMENT_SCREENSHOT_TIMEOUT_MS });
    } else if (options.fullPage) {
      png = await page.screenshot({ fullPage: true });
    } else {
      png = await page.screenshot();
    }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Screenshot failed (${label}): ${cause}` };
  }
  return toCapturedImage(png, label);
}

// Mobile first, desktop last: the page ends at the context's default
// (desktop) viewport, so later default captures are unaffected.
const RESPONSIVE_VIEWPORTS = [MOBILE_VIEWPORT, DESKTOP_VIEWPORT] as const;

async function captureResponsive(page: CapturePage): Promise<Result<CapturedImage[]>> {
  const images: CapturedImage[] = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    const label = `${viewport.width}px`;
    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to set viewport to ${viewport.width}x${viewport.height}: ${cause}` };
    }
    const shot = await captureOne(page, {}, label);
    if (!shot.ok) return shot;
    images.push(shot.value);
  }
  return { ok: true, value: images };
}

function toCapturedImage(png: Buffer, label: string): Result<CapturedImage> {
  const dimensions = readPngDimensions(png);
  if (!dimensions.ok) return dimensions;

  const image: CapturedImage = {
    label,
    base64: png.toString("base64"),
    widthPx: dimensions.value.width,
    heightPx: dimensions.value.height,
  };
  if (image.widthPx > MAX_IMAGE_WIDTH_PX) image.downscaleToWidthPx = MAX_IMAGE_WIDTH_PX;
  return { ok: true, value: image };
}

// ---------------------------------------------------------------------------
// PNG header parsing
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Width and height live in the IHDR chunk, which the spec requires to be
// first: 8-byte signature, 4-byte length, 4-byte "IHDR" type, then the fields.
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;
const PNG_MIN_HEADER_BYTES = PNG_IHDR_HEIGHT_OFFSET + 4;

function readPngDimensions(png: Buffer): Result<{ width: number; height: number }> {
  if (png.length < PNG_MIN_HEADER_BYTES || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: false, error: "Screenshot did not produce a valid PNG" };
  }
  return {
    ok: true,
    value: {
      width: png.readUInt32BE(PNG_IHDR_WIDTH_OFFSET),
      height: png.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET),
    },
  };
}
