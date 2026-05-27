/**
 * Websearch extension entry point.
 *
 * Registers a web_search tool backed by the Tavily API. This is the only
 * file in the extension that imports from `@earendil-works/pi-coding-agent`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { registerWebSearchTools } from "./tools.js";

export default function websearchExtension(pi: ExtensionAPI): void {
  registerWebSearchTools(
    pi.registerTool.bind(pi),
    Type.Object,
    Type.String,
    Type.Optional,
    Type.Integer,
    Type.Boolean,
  );
}
