/**
 * The `browser_check` tool: one screenshot of the persistent headless browser
 * page bundled with the cheap text signals (console errors/warnings, failed
 * network requests, uncaught exceptions) accumulated since the last check.
 *
 * Registration, execution, and TUI rendering live here; the pure
 * result-assembly helpers live in result.ts. Does not import from the pi
 * extension API package — the registrar and the image-resize helper are
 * received as opaque parameters so the entry point stays the sole importer.
 */

import { type Component, Container, Image, type ImageTheme, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

import { capture, type CaptureOptions } from "./capture.js";
import type { BrowserManager } from "./manager.js";
import {
  buildCheckContent,
  type CheckImage,
  type ContentPart,
  formatSignalsText,
  prepareCheckImage,
  type ResizeImageFn,
  summarizeSignalCounts,
} from "./result.js";
import type { PageEventSource, SignalBuffer } from "./signals.js";

const browserCheckParameters = Type.Object({
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
});

type BrowserCheckInput = Static<typeof browserCheckParameters>;

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

/** What execute returns; structurally compatible with pi's AgentToolResult. */
interface BrowserCheckResult {
  content: ContentPart[];
  details: BrowserCheckDetails;
  isError?: boolean;
}

/** Structural subset of pi's Theme used by the render callbacks. */
interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Structural subset of pi's ToolDefinition covering exactly the fields this
 * tool provides. `parameters` is typed as the concrete schema (not a bare
 * TObject) so pi infers precise param types for execute/renderCall, keeping
 * the strict function-type checks at the registration site satisfied.
 */
interface BrowserCheckToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: typeof browserCheckParameters;
  execute(toolCallId: string, params: BrowserCheckInput): Promise<BrowserCheckResult>;
  renderCall(args: BrowserCheckInput, theme: RenderTheme): Component;
  /** `details` is optional here: pi may render partial/streaming results. */
  renderResult(result: { details?: BrowserCheckDetails }, options: unknown, theme: RenderTheme): Component;
}

type ToolRegistrar = (definition: BrowserCheckToolDefinition) => void;

/** Everything the tool needs, wired up by the extension entry point. */
export interface BrowserCheckWiring {
  register: ToolRegistrar;
  manager: BrowserManager;
  signals: SignalBuffer;
  resizeImage: ResizeImageFn;
}

function describeMode(params: BrowserCheckInput): string {
  if (params.responsive) return "responsive 390px+1440px";
  if (params.selector) return `element ${params.selector}`;
  return params.fullPage ? "fullPage" : "viewport";
}

function errorResult(message: string, url: string, mode: string): BrowserCheckResult {
  const details: BrowserCheckDetails = { url, mode, images: [], summary: message, error: message };
  return { content: [{ type: "text", text: message }], details, isError: true };
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
    parameters: browserCheckParameters,

    async execute(_toolCallId, params) {
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

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("browser_check ")) +
        theme.fg("muted", `${args.url} (${describeMode(args)})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details;
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
