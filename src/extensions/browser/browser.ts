/**
 * Browser extension entry point.
 *
 * Owns the persistent headless Chromium instance used for visual feedback on
 * front-end work. This is the only file in the extension that imports from
 * `@earendil-works/pi-coding-agent`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BrowserManager } from "./manager.js";

export default function browserExtension(pi: ExtensionAPI): void {
  const manager = new BrowserManager();

  pi.on("session_shutdown", async (_event, ctx) => {
    const closed = await manager.close();
    if (!closed.ok) ctx.ui.notify(closed.error, "warning");
  });
}
