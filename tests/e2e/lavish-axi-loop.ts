/**
 * Standalone e2e smoke test for the lavish-axi feedback loop as wired into the
 * designer workflow (docs/design-tooling-proposal.md Phase 1, and the
 * "Richer feedback via lavish-axi" section of skills/design-system/SKILL.md).
 *
 * It exercises the REAL external CLI (`npx -y lavish-axi`, v0.1.31) end to end:
 * write a design-direction HTML fixture, open a session keyed by canonical file
 * path, assert the documented poll long-poll/timeout + feedback output shapes,
 * document the layout-audit situation, and (optionally) run the human
 * annotate -> poll round-trip. Everything it allocates is torn down at the end.
 *
 * Source of truth for the CLI surface and output shapes: docs/lavish-axi-cli.md.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites:
 *   - node + npx on PATH. On this machine:
 *       export PATH="/home/arjunbhargava/.nvm/versions/node/v22.22.2/bin:$PATH"
 *   - Network access for the FIRST `npx -y lavish-axi` fetch (cached after).
 *   - For the HUMAN round-trip step only (opt-in, see below): a local browser
 *     + display so a human can open the printed URL and annotate the artifact.
 *
 * Command (headless automated assertions only — no human needed):
 *     npx tsx tests/e2e/lavish-axi-loop.ts
 *
 * Command (headless assertions + live human annotate -> poll round-trip):
 *     LAVISH_LIVE=1 npx tsx tests/e2e/lavish-axi-loop.ts
 *   In LAVISH_LIVE mode the script prints a session URL, opens it if a browser
 *   launcher is available, and waits (up to LAVISH_LIVE_TIMEOUT_MS, default
 *   180000) for the human to click an element, type an annotation, and press
 *   "Send to Agent". It then asserts the returned prompts[] payload.
 *
 * Expected duration:
 *   - Headless only: ~20-40s (dominated by repeated `npx` process startup).
 *   - With LAVISH_LIVE=1: + however long the human takes to annotate.
 *
 * TODO(live-verify): As of the commit that introduced this file, the human
 * annotate -> poll round-trip (STEP 5) had NOT been live-verified in this
 * session. A future runner must run with LAVISH_LIVE=1, perform a real browser
 * annotation, and confirm STEP 5 reports PASS. The headless assertions
 * (STEPS 1-4) do not require a human and stand on their own.
 *
 * Teardown: every session this script opens is `end`-ed, the background server
 * is `stop`-ped, any spawned poll child process is killed, and the temp fixture
 * directory is removed — on success and on failure (see runTeardown()).
 * ---------------------------------------------------------------------------
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36mi\x1b[0m";
const SKIP = "\x1b[33m∅\x1b[0m";

const LIVE = process.env.LAVISH_LIVE === "1";
const LIVE_TIMEOUT_MS = Number(process.env.LAVISH_LIVE_TIMEOUT_MS ?? 180_000);

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function note(label: string) {
  console.log(`  ${INFO} ${label}`);
}

function skip(label: string) {
  console.log(`  ${SKIP} ${label}`);
  skipped++;
}

const NON_NUMERIC_FAILURE_EXIT_CODE = 124;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  failedToSpawn: boolean;
}

interface CliResultInput {
  stdout: string;
  stderr: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  failedToSpawn?: boolean;
}

function normalizeCliResult(input: CliResultInput): CliResult {
  const signal = input.signal ?? null;
  const timedOut = input.timedOut ?? false;
  const failedToSpawn = input.failedToSpawn ?? false;
  const code =
    typeof input.code === "number"
      ? input.code
      : signal || timedOut || failedToSpawn
        ? NON_NUMERIC_FAILURE_EXIT_CODE
        : 0;

  return {
    stdout: input.stdout,
    stderr: input.stderr,
    code,
    signal,
    timedOut,
    failedToSpawn,
  };
}

function cliResultDetail(result: CliResult): string {
  const parts = [`exit ${result.code}`];
  if (result.signal) parts.push(`signal ${result.signal}`);
  if (result.timedOut) parts.push("timed out");
  if (result.failedToSpawn) parts.push("failed to spawn");
  return parts.join(", ");
}

function hasStatus(result: CliResult, status: string): boolean {
  return result.code === 0 && new RegExp(`status:\\s*${status}\\b`).test(result.stdout);
}

function lavishCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (lavishPort !== null) env.LAVISH_AXI_PORT = String(lavishPort);
  if (lavishStateDir !== null) env.LAVISH_AXI_STATE_DIR = lavishStateDir;
  return env;
}

/**
 * Run `npx -y lavish-axi <args...>` to completion and capture stdout/stderr and
 * the exit code. Never throws on a non-zero exit; the caller asserts the code.
 */
function runCli(args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["-y", "lavish-axi", ...args],
      { timeout: timeoutMs, encoding: "utf8", env: lavishCliEnv() },
      (err, stdout, stderr) => {
        const error = err as {
          code?: unknown;
          killed?: unknown;
          signal?: NodeJS.Signals | null;
        } | null;
        const code = typeof error?.code === "number" ? error.code : null;
        const signal = error?.signal ?? null;
        const timedOut = Boolean(error?.killed);
        const failedToSpawn = Boolean(error && code === null && !signal && !timedOut);
        resolve(
          normalizeCliResult({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: err ? code : 0,
            signal,
            timedOut,
            failedToSpawn,
          }),
        );
      },
    );
  });
}

/** Compute the lavish-axi session key: sha256(canonical path) truncated to 16 hex. */
function sessionKeyForPath(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

/** Parse the session URL out of an `open` command's TOON output, if present. */
function parseSessionUrl(stdout: string): string | null {
  const m = stdout.match(/url:\s*"?(http:\/\/[^"\s]+)"?/);
  return m ? m[1] : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port for lavish-axi e2e"));
        return;
      }
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (isListening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isListening);
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForPortRelease(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!(await isPortListening(port))) return true;
    await sleep(250);
  }
  return false;
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// --- Resources allocated by this run (for teardown) ---------------------------
let tmpDir: string | null = null;
let lavishStateDir: string | null = null;
let lavishPort: number | null = null;
const openedFiles = new Set<string>();
let pollChild: ChildProcess | null = null;

async function runTeardown() {
  console.log("\n7. Teardown");
  if (pollChild && pollChild.exitCode === null && pollChild.signalCode === null) {
    const child = pollChild;
    child.kill("SIGTERM");
    const closed = await waitForChildClose(child, 5_000);
    check("background poll child terminated", closed, `pid=${child.pid}`);
  }

  const endSession = async (file: string) => {
    const end = await runCli(["end", file], 30_000);
    check(
      `session ended: ${file}`,
      hasStatus(end, "ended"),
      `${cliResultDetail(end)}; stdout=${end.stdout.trim() || "(empty)"}`,
    );
  };
  const openedFileList = Array.from(openedFiles);
  const finalFile = openedFileList.at(-1);

  // v0.1.31 auto-stops after the last session ends, before `stop` can report `status: stopped`.
  for (const file of openedFileList.slice(0, -1)) {
    await endSession(file);
  }

  if (openedFileList.length > 0) {
    const stop = await runCli(["stop"], 30_000);
    check(
      "server stopped",
      hasStatus(stop, "stopped"),
      `${cliResultDetail(stop)}; stdout=${stop.stdout.trim() || "(empty)"}`,
    );
  }

  if (finalFile) {
    await endSession(finalFile);
  }

  if (lavishPort !== null) {
    const released = await waitForPortRelease(lavishPort);
    check(`no listener remains on port ${lavishPort}`, released);
  }

  if (tmpDir) {
    const removedDir = tmpDir;
    rmSync(removedDir, { recursive: true, force: true });
    check(`temp fixture dir removed: ${removedDir}`, !existsSync(removedDir));
  }
}

async function main() {
  console.log(`lavish-axi feedback-loop e2e  (LIVE=${LIVE})\n`);

  // === 0. CLI availability and helper invariants ===
  console.log("0. CLI availability and helper invariants");
  const signaledFailure = normalizeCliResult({
    stdout: "",
    stderr: "",
    code: null,
    signal: "SIGTERM",
    timedOut: true,
  });
  check(
    "signal-only CLI failure maps to a non-zero sentinel",
    signaledFailure.code === NON_NUMERIC_FAILURE_EXIT_CODE,
    cliResultDetail(signaledFailure),
  );
  check(
    "teardown status checks reject timed-out commands",
    !hasStatus(signaledFailure, "ended"),
    cliResultDetail(signaledFailure),
  );
  const ver = await runCli(["--version"], 120_000);
  const version = ver.stdout.trim();
  check("lavish-axi --version returns a version", /^\d+\.\d+\.\d+/.test(version), version);
  note(`version under test: ${version || "(empty)"}`);

  // === 1. Open a session keyed by canonical file path ===
  console.log("\n1. Session start, keyed by canonical file path");
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "lavish-loop-")));
  lavishStateDir = join(tmpDir, "state");
  lavishPort = await getFreePort();
  note(`isolated lavish-axi state dir: ${lavishStateDir}`);
  note(`isolated lavish-axi port: ${lavishPort}`);
  const artifact = join(tmpDir, "direction.html");
  writeFileSync(
    artifact,
    [
      "<!doctype html>",
      '<html data-theme="luxury"><head><meta charset="utf-8">',
      "<title>Design direction</title></head>",
      "<body><main style=\"max-width:48rem;margin:2rem auto;font-family:sans-serif\">",
      "<h1>Direction A</h1>",
      "<p>A clean, narrow review surface for the designer feedback loop.</p>",
      "</main></body></html>",
    ].join("\n"),
  );

  const open = await runCli([artifact, "--no-open"], 60_000);
  openedFiles.add(artifact);
  check("open exits 0", open.code === 0, cliResultDetail(open));
  check("open reports status: opened", /status:\s*opened/.test(open.stdout));
  const url = parseSessionUrl(open.stdout);
  check("open returns a loopback session URL", !!url && url.startsWith("http://127.0.0.1:"), url ?? "no url");

  const expectedKey = sessionKeyForPath(artifact);
  check(
    "session URL key == sha256(canonical path)[:16]",
    !!url && url.endsWith(`/session/${expectedKey}`),
    `expected …/session/${expectedKey}, got ${url}`,
  );
  note(`session url: ${url}`);

  // Re-open the same path -> must resume the SAME session (same URL).
  const reopen = await runCli([artifact, "--no-open"], 60_000);
  const reUrl = parseSessionUrl(reopen.stdout);
  check("re-open same path resumes same session URL", !!reUrl && reUrl === url, `${url} vs ${reUrl}`);

  // === 2. Poll long-poll timeout shape ===
  console.log("\n2. Poll — timeout case (documented escape hatch)");
  const pollTimeout = await runCli(["poll", artifact, "--timeout-ms", "3000"], 30_000);
  check("poll timeout exits 0", pollTimeout.code === 0, cliResultDetail(pollTimeout));
  check("poll timeout reports status: waiting", /status:\s*waiting/.test(pollTimeout.stdout));
  check(
    "poll timeout next_step tells caller to re-run without --timeout-ms",
    /poll[\s\S]*without --timeout-ms/.test(pollTimeout.stdout),
  );
  check(
    "poll timeout did NOT emit feedback prompts",
    !/status:\s*feedback/.test(pollTimeout.stdout) && !/prompts\[/.test(pollTimeout.stdout),
  );

  // === 3. Poll feedback shape via headless prompt injection ===
  // The browser annotate UI is what a human drives; headlessly we POST a prompt
  // to the documented session API while a poll is running and assert the poll
  // returns the documented feedback payload. This validates the poll-side output
  // contract (the same contract STEP 5 verifies through a real browser).
  console.log("\n3. Poll — feedback case (headless prompt injection)");
  const port = url ? new URL(url).port : String(lavishPort ?? 4387);
  const apiUrl = `http://127.0.0.1:${port}/api/${expectedKey}/prompts`;
  const injected = {
    uid: "e2e-inject-001",
    prompt: "Tighten the heading spacing",
    selector: "h1",
    tag: "element",
    text: "Direction A",
  };

  const pollOut = await new Promise<CliResult>((resolve) => {
    const child = spawn("npx", ["-y", "lavish-axi", "poll", artifact, "--timeout-ms", "15000"], {
      encoding: "utf8",
      env: lavishCliEnv(),
    } as never);
    pollChild = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      pollChild = null;
      resolve(result);
    };
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", () => {
      finish(
        normalizeCliResult({
          stdout,
          stderr,
          code: null,
          signal: null,
          failedToSpawn: true,
        }),
      );
    });
    child.on("close", (code, signal) => {
      finish(normalizeCliResult({ stdout, stderr, code, signal }));
    });
    // POST the prompt shortly after the poll attaches.
    setTimeout(async () => {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompts: [injected] }),
        });
        note(`prompt POST -> ${apiUrl} : HTTP ${res.status}`);
      } catch (e) {
        note(`prompt POST failed: ${(e as Error).message}`);
      }
    }, 1500);
  });

  check("poll returns after injected feedback (exit 0)", pollOut.code === 0, cliResultDetail(pollOut));
  check("poll reports status: feedback", /status:\s*feedback/.test(pollOut.stdout));
  check("poll output declares prompts[] block", /prompts\[\d+\]/.test(pollOut.stdout));
  check("poll payload carries the injected uid", pollOut.stdout.includes(injected.uid));
  check("poll payload carries the injected prompt text", pollOut.stdout.includes(injected.prompt));
  check("poll payload carries the injected selector", pollOut.stdout.includes(injected.selector));
  check(
    "poll payload exposes documented fields {uid,prompt,selector,tag,text}",
    /prompts\[\d+\]\{[^}]*uid[^}]*prompt[^}]*selector[^}]*tag[^}]*text[^}]*\}/.test(pollOut.stdout),
  );
  if (!/status:\s*feedback/.test(pollOut.stdout)) {
    note(`poll stdout was:\n${pollOut.stdout.trim()}`);
  }

  // === 4. Layout-audit path ===
  // The task asks to surface a layout_warnings result for a forced-overflow
  // artifact OR document precisely why it could not be exercised headlessly.
  // Per docs/lavish-axi-cli.md ("layout_warnings — not present in v0.1.31"),
  // no such field exists in the v0.1.31 CLI surface or README. We assert the
  // negative: an overflow artifact's poll output contains no layout_warnings.
  console.log("\n4. Layout audit — documented absence in v0.1.31");
  const overflowArtifact = join(tmpDir, "overflow.html");
  writeFileSync(
    overflowArtifact,
    [
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\"><title>Overflow</title></head>",
      // Force horizontal overflow well beyond any viewport.
      "<body style=\"margin:0\"><div style=\"width:6000px;height:80px;white-space:nowrap\">",
      "FORCED_HORIZONTAL_OVERFLOW ".repeat(60),
      "</div></body></html>",
    ].join("\n"),
  );
  const openOverflow = await runCli([overflowArtifact, "--no-open"], 60_000);
  openedFiles.add(overflowArtifact);
  check("overflow artifact opens (exit 0)", openOverflow.code === 0, cliResultDetail(openOverflow));
  const overflowPoll = await runCli(["poll", overflowArtifact, "--timeout-ms", "3000"], 30_000);
  check(
    "overflow poll emits no layout_warnings field (absent in v0.1.31)",
    !/layout_warnings/.test(overflowPoll.stdout),
  );
  note(
    "layout_warnings is NOT part of the v0.1.31 CLI surface (see docs/lavish-axi-cli.md). " +
      "The forced-overflow fixture confirms no layout-audit output is produced; the audit path " +
      "cannot be exercised headlessly against this version. Re-evaluate if a later CLI adds it.",
  );

  // === 5. Human annotate -> poll round-trip ===
  console.log("\n5. Human annotate -> poll round-trip");
  if (!LIVE) {
    skip("LAVISH_LIVE != 1 — round-trip not run this invocation");
    note(
      "TODO(live-verify): re-run with `LAVISH_LIVE=1 npx tsx tests/e2e/lavish-axi-loop.ts`, " +
        "open the printed URL in a browser, click an element, type an annotation, press " +
        "\"Send to Agent\", and confirm this step reports PASS.",
    );
  } else {
    // Open with a real browser launch so the human has a window to annotate.
    const liveOpen = await runCli([artifact], 60_000);
    const liveUrl = parseSessionUrl(liveOpen.stdout) ?? url;
    console.log("\n  === ARTIFACT ===");
    console.log(`  session_url:  ${liveUrl}`);
    console.log(`  artifact:     ${artifact}`);
    console.log("  action:       open the URL, click the <h1>, type any note, press \"Send to Agent\"");
    console.log("  ================\n");
    note(`waiting up to ${LIVE_TIMEOUT_MS}ms for a real human annotation…`);

    const liveStart = Date.now();
    const livePoll = await runCli(["poll", artifact, "--timeout-ms", String(LIVE_TIMEOUT_MS)], LIVE_TIMEOUT_MS + 30_000);
    const elapsed = Date.now() - liveStart;
    const gotFeedback = /status:\s*feedback/.test(livePoll.stdout);
    check("live poll exits 0", livePoll.code === 0, cliResultDetail(livePoll));
    check("live poll returned human feedback (status: feedback)", gotFeedback, `after ${elapsed}ms`);
    check("live feedback contains a prompts[] payload", /prompts\[\d+\]/.test(livePoll.stdout));
    check(
      "live feedback prompt text is non-empty",
      /prompts\[\d+\]\{[\s\S]*?\n\s+\S+,.+/.test(livePoll.stdout),
    );
    note(`live poll stdout:\n${livePoll.stdout.trim()}`);
  }

  // === 6. Summary precedes teardown ===
  console.log("\n6. (assertions complete)");
}

let teardownError: unknown = null;
main()
  .catch((err) => {
    console.error("\nFatal during test body:", err);
    failed++;
  })
  .finally(async () => {
    try {
      await runTeardown();
    } catch (e) {
      teardownError = e;
      failed++;
      console.error("Teardown error:", e);
    }
    console.log(`\n${"=".repeat(56)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (!LIVE) {
      console.log("Status: DEFERRED — STEP 5 (human round-trip) marked TODO(live-verify).");
    }
    if (teardownError) console.log("WARNING: teardown reported an error — verify no resources leaked.");
    process.exit(failed > 0 ? 1 : 0);
  });
