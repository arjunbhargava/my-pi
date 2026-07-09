/**
 * Browser extension entry point.
 *
 * Owns the persistent headless Chromium instance used for visual feedback on
 * front-end work. This is the only file in the extension that imports from
 * `@earendil-works/pi-coding-agent`.
 */

import { type ExtensionAPI, resizeImage } from "@earendil-works/pi-coding-agent";

import { BrowserManager } from "./manager.js";
import { SignalBuffer } from "./signals.js";
import { registerBrowserCheck } from "./tools.js";

export default function browserExtension(pi: ExtensionAPI): void {
  const manager = new BrowserManager();
  const signals = new SignalBuffer();

  registerBrowserCheck({
    register: pi.registerTool.bind(pi),
    manager,
    signals,
    resizeImage,
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    signals.detach();
    const closed = await manager.close();
    if (!closed.ok) ctx.ui.notify(closed.error, "warning");
  });
}
