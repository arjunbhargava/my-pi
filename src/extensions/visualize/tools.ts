/**
 * Tool and command registration for the visualize extension.
 *
 * Does not import from `@earendil-works/pi-coding-agent` — pi is received
 * as an opaque parameter to keep the entry point as the sole importer.
 */

import { Image, type ImageTheme, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

/**
 * Produces a typebox schema that encodes as `{ type: "string", enum: [...] }`.
 * Google's API requires this representation rather than the anyOf/const pattern
 * that `Type.Union([Type.Literal(...)])` generates.
 */
function StringEnum<T extends readonly string[]>(values: T): ReturnType<typeof Type.Unsafe<T[number]>> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

import { renderSvgToPng } from "./render.js";
import type { VisualizeToolDetails, VisualizeToolInput } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's ExtensionAPI; imported only in the entry point
type PiAPI = any;

/**
 * Register the `visualize` tool and `/visualize` command with pi.
 * Both share the `lastVisualization` closure so the command can replay the
 * most recent render.
 *
 * @param pi - The pi ExtensionAPI instance.
 */
export function registerVisualize(pi: PiAPI): void {
  let lastVisualization: VisualizeToolDetails | undefined;

  // -------------------------------------------------------------------------
  // Tool
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "visualize",
    label: "Visualize",
    description:
      "Render an SVG visualization inline in the TUI as a PNG image. " +
      "The `content` field must be complete, valid SVG markup with explicit " +
      "width and height attributes. HTML is not yet supported.",
    promptSnippet: "Render an SVG visualization (charts, diagrams) inline in the TUI",
    promptGuidelines: [
      "Use visualize when the user asks for a chart, diagram, or visual that is better " +
        "shown as an image than as ASCII art. Provide complete, valid SVG markup with " +
        "explicit width and height attributes.",
    ],
    parameters: Type.Object({
      // Cast required: StringEnum returns TUnsafe; Type.Object expects TSchema from the same typebox version
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: StringEnum(["svg"] as const) as any,
      content: Type.String({ description: "Complete SVG markup to render." }),
      title: Type.Optional(Type.String({ description: "Optional human-readable label for the visualization." })),
    }),

    async execute(_toolCallId: string, params: VisualizeToolInput) {
      const result = await renderSvgToPng(params.content);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          details: { kind: params.kind, title: params.title, error: result.error } satisfies VisualizeToolDetails,
          isError: true,
        };
      }

      const label = params.title ?? "visualization";
      const details: VisualizeToolDetails = {
        kind: params.kind,
        title: params.title,
        imageBase64: result.imageBase64,
        widthPx: result.widthPx,
        heightPx: result.heightPx,
      };

      lastVisualization = details;

      return {
        content: [
          {
            type: "text",
            text: `Rendered "${label}" (${result.widthPx}x${result.heightPx}px)`,
          },
        ],
        details,
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- theme type from pi
    renderCall(args: VisualizeToolInput, theme: any) {
      let text = theme.fg("toolTitle", theme.bold("visualize ")) + theme.fg("muted", args.kind);
      if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
      return new Text(text, 0, 0);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result/theme/options types from pi
    renderResult(result: any, _options: any, theme: any) {
      const details = result.details as VisualizeToolDetails | undefined;

      if (!details?.imageBase64) {
        const errorMsg = details?.error ?? "Render failed — no image data";
        return new Text(theme.fg("error", errorMsg), 0, 0);
      }

      const imageTheme: ImageTheme = { fallbackColor: (s: string) => theme.fg("dim", s) };
      return new Image(details.imageBase64, "image/png", imageTheme, {
        maxWidthCells: 80,
        maxHeightCells: 40,
      });
    },
  });

  // -------------------------------------------------------------------------
  // Command
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ctx type from pi
  pi.registerCommand("visualize", {
    description: "Show the most recent visualization in an overlay",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ctx type from pi
    handler: async (_args: string, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/visualize requires interactive mode", "error");
        return;
      }

      if (!lastVisualization?.imageBase64) {
        ctx.ui.notify("No visualization to show yet", "info");
        return;
      }

      const viz = lastVisualization;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- theme/done types from pi
      await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: (v: void) => void) => {
        const imageTheme: ImageTheme = { fallbackColor: (s: string) => theme.fg("dim", s) };
        const img = new Image(viz.imageBase64!, "image/png", imageTheme, {
          maxWidthCells: 80,
          maxHeightCells: 40,
        });

        return {
          render: (width: number) => img.render(width),
          invalidate: () => img.invalidate(),
          handleInput: (data: string) => {
            if (data === "\x1b") done(undefined);
          },
        };
      }, { overlay: true });
    },
  });
}

