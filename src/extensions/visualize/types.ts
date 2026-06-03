/**
 * Type definitions for the visualize extension.
 * No logic — only type declarations.
 */

/** The rendering format for a visualization. Currently only SVG is supported. */
export type VisualizeKind = "svg";

/** Parameters passed by the agent when invoking the visualize tool. */
export interface VisualizeToolInput {
  kind: VisualizeKind;
  /** Raw source content (e.g. SVG markup). */
  content: string;
  /** Optional human-readable label shown above the rendered output. */
  title?: string;
}

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
