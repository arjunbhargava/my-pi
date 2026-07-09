/**
 * The `browser_check` tool: one screenshot of the persistent headless browser
 * page bundled with the cheap text signals (console errors/warnings, failed
 * network requests, uncaught exceptions) accumulated since the last check.
 *
 * Does not import from the pi extension API package — the registrar and
 * the image-resize helper are received as opaque parameters so the entry
 * point stays the sole importer.
 */

import { Container, Image, type ImageTheme, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { capture, type CaptureOptions, type CapturedImage } from "./capture.js";
import type { Result } from "../../lib/types.js";
import type { BrowserManager } from "./manager.js";
import type { PageEventSource, PageSignals, SignalBuffer } from "./signals.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's registerTool uses complex generic types from typebox
type ToolRegistrar = (def: any) => void;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

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

interface BrowserCheckInput {
  url: string;
  fullPage?: boolean;
  selector?: string;
  responsive?: boolean;
  compareToPrevious?: boolean;
}

/** Details attached to every browser_check result, used by renderResult. */
export interface BrowserCheckDetails {
  url: string;
  mode: string;
  images: Array<{ label: string; widthPx: number; heightPx: number }>;
  /** One readable line, e.g. "viewport 1440x900 — 2 console errors". */
  summary: string;
  /** First current screenshot for TUI display; absent on error. */
  imageBase64?: string;
  imageMimeType?: string;
  error?: string;
}

/** Everything the tool needs, wired up by the extension entry point. */
export interface BrowserCheckWiring {
  register: ToolRegistrar;
  manager: BrowserManager;
  signals: SignalBuffer;
  resizeImage: ResizeImageFn;
}

// ---------------------------------------------------------------------------
// Pure result-assembly helpers (unit-testable without a browser)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function describeMode(params: BrowserCheckInput): string {
  if (params.responsive) return "responsive 390px+1440px";
  if (params.selector) return `element ${params.selector}`;
  return params.fullPage ? "fullPage" : "viewport";
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

function errorResult(message: string, url: string, mode: string) {
  const details: BrowserCheckDetails = { url, mode, images: [], summary: message, error: message };
  return { content: [{ type: "text", text: message }] as ContentPart[], details, isError: true };
}

/**
 * Register the `browser_check` tool. The previous screenshot (for
 * before/after comparison) and the navigated URL live in this closure, scoped
 * to the session.
 *
 * @param wiring - Registrar, browser manager, signal buffer, and pi's
 * resizeImage, all provided by the extension entry point.
 */
export function registerBrowserCheck(wiring: BrowserCheckWiring): void {
  const { register, manager, signals, resizeImage } = wiring;

  let attachedPage: PageEventSource | null = null;
  let currentUrl: string | null = null;
  let lastScreenshot: CheckImage | null = null;

  register({
    name: "browser_check",
    label: "Browser Check",
    description:
      "Navigate a persistent headless browser to a URL and return a screenshot PLUS everything that went " +
      "wrong since the last check: console errors and warnings, failed network requests, and uncaught " +
      "exceptions — in one result. The browser and page persist across calls: the first call launches and " +
      "navigates; later calls with the same url skip navigation and re-screenshot the warm page, so after " +
      "editing files served by an HMR dev server (e.g. Vite), call again with the same url to see the update.",
    promptSnippet:
      "Screenshot a URL in a persistent headless browser, bundled with console errors, failed requests, and exceptions since the last check.",
    promptGuidelines: [
      "Use browser_check to visually verify front-end changes against a running dev server. Prefer an HMR " +
        "dev server (vite dev) over rebuild-per-check; re-call with the same url after edits.",
      "Screenshot after a coherent batch of visual edits, not after every edit.",
      "Read the signals text before the pixels — a console error usually explains a blank or broken page.",
      "Set responsive: true when layout matters across screen sizes (captures 390px and 1440px in one call).",
      "Keep the default viewport shot; use fullPage or selector only when you need them (full-page shots of " +
        "long pages downscale into illegibility; a selector crop preserves typography detail).",
      "Set compareToPrevious: true after making a change to judge before/after instead of re-reasoning from scratch.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description:
          "Page to check, typically a local dev server URL. First call navigates; subsequent calls with the " +
          "same url reuse the warm page (HMR-friendly).",
      }),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page. Default false (viewport only)." })),
      selector: Type.Optional(Type.String({ description: "CSS selector: crop the screenshot to this element." })),
      responsive: Type.Optional(Type.Boolean({ description: "Capture both 390px and 1440px viewports. Default false." })),
      compareToPrevious: Type.Optional(Type.Boolean({
        description: "Also include the previous screenshot from this session, labeled before/after. Default false.",
      })),
    }),

    async execute(_toolCallId: string, params: BrowserCheckInput) {
      const mode = describeMode(params);

      const launched = await manager.launch();
      if (!launched.ok) return errorResult(launched.error, params.url, mode);
      if (attachedPage !== launched.value) {
        // Attach before navigation so navigation-time signals are captured.
        signals.attach(launched.value);
        attachedPage = launched.value;
        currentUrl = null;
      }

      if (currentUrl !== params.url) {
        const navigated = await manager.goto(params.url);
        if (!navigated.ok) return errorResult(navigated.error, params.url, mode);
        currentUrl = params.url;
      }

      const captureOptions: CaptureOptions = {};
      if (params.responsive) captureOptions.viewports = "responsive";
      if (params.fullPage) captureOptions.fullPage = true;
      if (params.selector) captureOptions.selector = params.selector;

      const captured = await capture(launched.value, captureOptions);
      if (!captured.ok) return errorResult(captured.error, params.url, mode);

      const images: CheckImage[] = [];
      for (const capturedImage of captured.value) {
        const prepared = await prepareCheckImage(capturedImage, resizeImage);
        if (!prepared.ok) return errorResult(prepared.error, params.url, mode);
        images.push(prepared.value);
      }
      const drained = signals.drain();

      let signalsText = formatSignalsText(drained);
      const previousImage = params.compareToPrevious ? lastScreenshot ?? undefined : undefined;
      if (params.compareToPrevious && !previousImage) {
        signalsText += "\n(No previous screenshot to compare; showing current only.)";
      }
      lastScreenshot = images[0] ?? null;

      const counts = summarizeSignalCounts(drained);
      const shotSummary = images.map((image) => `${image.label} ${image.widthPx}x${image.heightPx}`).join(", ");
      const details: BrowserCheckDetails = {
        url: params.url,
        mode,
        images: images.map(({ label, widthPx, heightPx }) => ({ label, widthPx, heightPx })),
        summary: counts ? `${shotSummary} — ${counts}` : `${shotSummary} — no signals`,
        imageBase64: images[0]?.data,
        imageMimeType: images[0]?.mimeType,
      };

      return { content: buildCheckContent(signalsText, images, previousImage), details };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- theme type from pi
    renderCall(args: BrowserCheckInput, theme: any) {
      const text =
        theme.fg("toolTitle", theme.bold("browser_check ")) +
        theme.fg("muted", `${args.url} (${describeMode(args)})`);
      return new Text(text, 0, 0);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result/theme/options types from pi
    renderResult(result: any, _options: any, theme: any) {
      const details = result.details as BrowserCheckDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);

      const summary = details?.summary ?? "no screenshot captured";
      if (!details?.imageBase64) return new Text(theme.fg("dim", summary), 0, 0);

      // Container: summary line stays readable when the terminal cannot
      // render images (SSH) and the Image degrades to its text fallback.
      const imageTheme: ImageTheme = { fallbackColor: (s: string) => theme.fg("dim", s) };
      const container = new Container();
      container.addChild(new Text(theme.fg("dim", summary), 0, 0));
      container.addChild(
        new Image(details.imageBase64, details.imageMimeType ?? "image/png", imageTheme, {
          maxWidthCells: 80,
          maxHeightCells: 40,
        }),
      );
      return container;
    },
  });
}
