/**
 * PDF extension entry point.
 *
 * Registers a read_pdf tool backed by unpdf (a bundled serverless build of
 * Mozilla's PDF.js). This is the only file in the extension that imports from
 * `@earendil-works/pi-coding-agent`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { registerPdfTools } from "./tools.js";

export default function pdfExtension(pi: ExtensionAPI): void {
  registerPdfTools(
    pi.registerTool.bind(pi),
    Type.Object,
    Type.String,
    Type.Optional,
    Type.Integer,
  );
}
