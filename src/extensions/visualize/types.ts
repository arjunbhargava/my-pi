/**
 * Type definitions for the visualize extension.
 * No logic — only type declarations.
 */

/**
 * The rendering format for a visualization.
 * - "svg": content is complete SVG markup rendered via sharp.
 * - "image": content is an image source — filesystem path, raw base64 string,
 *   data:image/... data-URI, or an http(s) URL — loaded via sharp.
 */
export type VisualizeKind = "svg" | "image";

/** Parameters passed by the agent when invoking the visualize tool. */
export interface VisualizeToolInput {
  kind: VisualizeKind;
  /** Raw source content (e.g. SVG markup). */
  content: string;
  /** Optional human-readable label shown above the rendered output. */
  title?: string;
}

/**
 * Result of any render or image-load operation.
 * On success, carries the PNG payload as base64 and the rasterised dimensions.
 * On failure, carries a human-readable explanation; the producing function never throws.
 */
export type VisualizeRenderResult =
  | { ok: true; imageBase64: string; widthPx: number; heightPx: number }
  | { ok: false; error: string };

/** Details returned by the visualize tool after rendering. */
export interface VisualizeToolDetails {
  kind: VisualizeKind;
  title?: string;
  /** Base64-encoded PNG of the rendered output. Omitted when rendering failed. */
  imageBase64?: string;
  widthPx?: number;
  heightPx?: number;
  /** Human-readable error message when rendering failed. */
  error?: string;
}
