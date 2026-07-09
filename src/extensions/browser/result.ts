/**
 * Pure result-assembly helpers for the `browser_check` tool: turning drained
 * page signals into readable text, enforcing the screenshot width clamp, and
 * building the mixed text/image content array. No browser or pi imports, so
 * everything here is unit-testable in isolation.
 */

import type { CapturedImage } from "./capture.js";
import type { Result } from "../../lib/types.js";
import type { PageSignals } from "./signals.js";

/** Structural subset of pi's ResizedImage (data is base64 without data-URI prefix). */
export interface ResizedImageLike {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/** Structural type of pi's `resizeImage`, passed in from the entry point. */
export type ResizeImageFn = (
  inputBytes: Uint8Array,
  mimeType: string,
  options?: { maxWidth?: number },
) => Promise<ResizedImageLike | null>;

/** A screenshot ready to go into a tool result content array. */
export interface CheckImage {
  label: string;
  /** Base64 image bytes, no data-URI prefix. */
  data: string;
  mimeType: string;
  widthPx: number;
  heightPx: number;
}

interface TextContentPart {
  type: "text";
  text: string;
}

interface ImageContentPart {
  type: "image";
  data: string;
  mimeType: string;
}

/** One entry of an AgentToolResult content array (structural). */
export type ContentPart = TextContentPart | ImageContentPart;

const NO_SIGNALS_TEXT = "No console errors, warnings, failed requests, or exceptions since last check.";

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One-line count summary of drained signals, e.g.
 * "2 console errors, 1 console warning, 1 failed request, 1 uncaught exception".
 * Returns null when there is nothing to report.
 */
export function summarizeSignalCounts(signals: PageSignals): string | null {
  const errors = signals.console.filter((entry) => entry.type === "error").length;
  const warnings = signals.console.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(countNoun(errors, "console error"));
  if (warnings > 0) parts.push(countNoun(warnings, "console warning"));
  if (signals.failedRequests.length > 0) parts.push(countNoun(signals.failedRequests.length, "failed request"));
  if (signals.exceptions.length > 0) parts.push(countNoun(signals.exceptions.length, "uncaught exception"));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Render drained page signals as the text block that precedes the screenshot
 * in the tool result: counts first, then each category's full content.
 *
 * @param signals - Signals drained from the buffer since the last check.
 */
export function formatSignalsText(signals: PageSignals): string {
  const counts = summarizeSignalCounts(signals);
  if (!counts) return NO_SIGNALS_TEXT;

  const lines: string[] = [`Since last check: ${counts}`];

  const errors = signals.console.filter((entry) => entry.type === "error");
  const warnings = signals.console.filter((entry) => entry.type === "warning");
  if (errors.length > 0) {
    lines.push("", "Console errors:");
    for (const entry of errors) lines.push(`  - ${entry.text}`);
  }
  if (warnings.length > 0) {
    lines.push("", "Console warnings:");
    for (const entry of warnings) lines.push(`  - ${entry.text}`);
  }
  if (signals.failedRequests.length > 0) {
    lines.push("", "Failed requests:");
    for (const request of signals.failedRequests) {
      const reason = request.status !== undefined ? `HTTP ${request.status}` : request.failureText ?? "failed";
      lines.push(`  - ${request.url} (${reason})`);
    }
  }
  if (signals.exceptions.length > 0) {
    lines.push("", "Uncaught exceptions:");
    for (const exception of signals.exceptions) {
      lines.push(`  - ${exception.message}`);
      if (exception.stack) lines.push(...exception.stack.split("\n").map((line) => `    ${line}`));
    }
  }
  return lines.join("\n");
}

/**
 * Assemble the content array for a browser_check result: signals text first
 * (so the model triages errors before pixels), then each screenshot preceded
 * by a text label. When `previousImage` is supplied it is included before the
 * current images, labeled "before"/"after" for diff prompting.
 *
 * @param signalsText - Output of {@link formatSignalsText}.
 * @param images - The current screenshots, in capture order.
 * @param previousImage - The screenshot stored from the prior check, if any.
 */
export function buildCheckContent(
  signalsText: string,
  images: CheckImage[],
  previousImage?: CheckImage,
): ContentPart[] {
  const parts: ContentPart[] = [{ type: "text", text: signalsText }];
  if (previousImage) {
    parts.push({ type: "text", text: `[before — previous check, ${previousImage.label} ${previousImage.widthPx}x${previousImage.heightPx}]` });
    parts.push({ type: "image", data: previousImage.data, mimeType: previousImage.mimeType });
  }
  for (const image of images) {
    const prefix = previousImage ? "after — " : "";
    parts.push({ type: "text", text: `[${prefix}${image.label} ${image.widthPx}x${image.heightPx}]` });
    parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return parts;
}

/**
 * Convert a captured screenshot into result-ready form, enforcing the width
 * clamp: images marked `downscaleToWidthPx` by capture.ts MUST be downscaled
 * before reaching the model. Returns an error — never an over-wide image —
 * when the resize backend is unavailable or fails.
 *
 * @param image - A screenshot from capture.ts.
 * @param resizeImage - pi's resize helper, injected by the entry point.
 */
export async function prepareCheckImage(
  image: CapturedImage,
  resizeImage: ResizeImageFn,
): Promise<Result<CheckImage>> {
  if (!image.downscaleToWidthPx) {
    return {
      ok: true,
      value: {
        label: image.label,
        data: image.base64,
        mimeType: "image/png",
        widthPx: image.widthPx,
        heightPx: image.heightPx,
      },
    };
  }

  let resized: ResizedImageLike | null;
  try {
    resized = await resizeImage(Buffer.from(image.base64, "base64"), "image/png", {
      maxWidth: image.downscaleToWidthPx,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to downscale ${image.label} screenshot (${image.widthPx}px wide): ${cause}` };
  }
  if (!resized) {
    return {
      ok: false,
      error:
        `Failed to downscale ${image.label} screenshot: it is ${image.widthPx}px wide ` +
        `(limit ${image.downscaleToWidthPx}px) and the resize backend returned no image. ` +
        "Retry with a narrower capture (e.g. a selector crop or the default viewport).",
    };
  }
  return {
    ok: true,
    value: { label: image.label, data: resized.data, mimeType: resized.mimeType, widthPx: resized.width, heightPx: resized.height },
  };
}
