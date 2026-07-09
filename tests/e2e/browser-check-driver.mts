/**
 * Live-verification driver for the `browser_check` tool (task 83413a7b).
 *
 * Exercises the REAL tool code path — not a mock. It constructs the same
 * wiring the extension entry point (src/extensions/browser/browser.ts) uses:
 * a BrowserManager, a SignalBuffer, and pi's resizeImage, passed to
 * registerBrowserCheck. It captures the registered tool definition and calls
 * its execute() against a locally served fixture page, then asserts on the
 * returned content array and details.
 *
 * Prereqs (see tests/e2e/browser-check.md for the full checklist):
 *   - npm install (playwright-core, @earendil-works/*, tsx)
 *   - node node_modules/playwright-core/cli.js install chromium
 *   - python3 on PATH (used to serve the fixture)
 *
 * Run:  npx tsx tests/e2e/browser-check-driver.ts
 * Exits 0 on all-pass, 1 on any failure. Tears down the browser and the
 * static server unconditionally.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { resizeImage } from "@earendil-works/pi-coding-agent";

import { BrowserManager } from "../../src/extensions/browser/manager.js";
import { SignalBuffer } from "../../src/extensions/browser/signals.js";
import { registerBrowserCheck, type ContentPart, type BrowserCheckDetails } from "../../src/extensions/browser/tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["BC_PORT"] ?? 8099);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/browser-check-fixture.html`;

interface ToolResult {
  content: ContentPart[];
  details: BrowserCheckDetails;
  isError?: boolean;
}
type ToolDef = { execute(id: string, params: unknown): Promise<ToolResult> };

const failures: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  const status = cond ? "PASS" : "FAIL";
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(label);
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}
function imageParts(result: ToolResult): ContentPart[] {
  return result.content.filter((p) => p.type === "image");
}

async function waitForServer(url: string, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(100);
  }
  throw new Error(`static server did not come up at ${url}`);
}

async function main(): Promise<void> {
  const manager = new BrowserManager();
  const signals = new SignalBuffer();

  // Capture the tool definition registered by registerBrowserCheck.
  let tool: ToolDef | null = null;
  registerBrowserCheck({
    register: (def) => {
      tool = def as ToolDef;
    },
    manager,
    signals,
    resizeImage,
  });
  if (!tool) throw new Error("registerBrowserCheck did not register a tool");
  const browserCheck: ToolDef = tool;

  // Serve the fixture directory with the exact server the checklist documents.
  const server: ChildProcess = spawn(
    "python3",
    ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", HERE],
    { stdio: "ignore" },
  );

  try {
    await waitForServer(FIXTURE_URL);

    // --- Step 4 (cold) + Step 3 (signals): first call cold-launches. --------
    console.log("\nCall A: default viewport (cold launch, first navigation)");
    const tA = Date.now();
    const a = await browserCheck.execute("A", { url: FIXTURE_URL });
    const coldMs = Date.now() - tA;
    const aText = textOf(a);
    const aImages = imageParts(a);
    check("A returns exactly one image", aImages.length === 1, `${aImages.length} image(s)`);
    check("A image base64 is non-empty", aImages[0]?.type === "image" && aImages[0].data.length > 100);
    check("A image width <= 1500px", (a.details.images[0]?.widthPx ?? 9999) <= 1500, `${a.details.images[0]?.widthPx}px`);
    check("A text has the console error", aText.includes("FIXTURE_CONSOLE_ERROR"));
    check("A text has the console warning", aText.includes("FIXTURE_CONSOLE_WARN"));
    check("A text has the failed request (HTTP 404)", aText.includes("__fixture_missing_resource__") && aText.includes("404"));
    check("A text has the uncaught exception", aText.includes("FIXTURE_UNCAUGHT_EXCEPTION"));

    // Save the first screenshot for optional human inspection.
    const outPng = "/tmp/browser-check-viewport.png";
    if (aImages[0]?.type === "image") writeFileSync(outPng, Buffer.from(aImages[0].data, "base64"));
    console.log(`  (saved viewport screenshot to ${outPng})`);

    // --- Step 3 (drain) + Step 4 (warm): second call, same url. -------------
    console.log("\nCall B: same url again (warm page, drains clean)");
    const tB = Date.now();
    const b = await browserCheck.execute("B", { url: FIXTURE_URL });
    const warmMs = Date.now() - tB;
    const bText = textOf(b);
    check("B drains clean (no stale signals)", bText.startsWith("No console errors"), JSON.stringify(bText.slice(0, 60)));
    check("B still returns a screenshot", imageParts(b).length === 1);
    check("warm call materially faster than cold", warmMs < coldMs, `cold=${coldMs}ms warm=${warmMs}ms`);

    // --- Step 5a: responsive returns two images. ----------------------------
    console.log("\nCall C: responsive: true (390px + 1440px)");
    const c = await browserCheck.execute("C", { url: FIXTURE_URL, responsive: true });
    const cLabels = c.details.images.map((i) => i.label);
    check("C returns two images", imageParts(c).length === 2, cLabels.join(", "));
    check("C has a 390px image", cLabels.includes("390px"));
    check("C has a 1440px image", cLabels.includes("1440px"));

    // --- Step 5b: selector returns an element crop. -------------------------
    console.log("\nCall D: selector '#crop-target' (element crop)");
    const d = await browserCheck.execute("D", { url: FIXTURE_URL, selector: "#crop-target" });
    const dImg = d.details.images[0];
    check("D returns one image", imageParts(d).length === 1);
    check("D image labeled as element crop", dImg?.label === "element:#crop-target", dImg?.label);
    check(
      "D crop smaller than the 1440px viewport",
      (dImg?.widthPx ?? 9999) < 1440,
      `${dImg?.widthPx}x${dImg?.heightPx}`,
    );
  } finally {
    // --- Teardown (mandatory): close browser, kill static server. -----------
    const closed = await manager.close();
    console.log(`\nTeardown: browser closed = ${closed.ok}${closed.ok ? "" : ` (${closed.error})`}`);
    server.kill("SIGTERM");
    await delay(200);
    console.log(`Teardown: static server killed = ${server.killed}`);
  }

  console.log(`\n${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.length}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("driver crashed:", err);
  process.exit(1);
});
