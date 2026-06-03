/**
 * Visualize extension entry point.
 *
 * Registers a `visualize` tool and `/visualize` command that render SVG
 * markup as a PNG image displayed inline in the TUI — analogous to the
 * Claude desktop sidebar visualization panel.
 *
 * This is the only file in the extension that imports from
 * `@earendil-works/pi-coding-agent`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerVisualize } from "./tools.js";

export default function visualizeExtension(pi: ExtensionAPI): void {
  registerVisualize(pi);
}
