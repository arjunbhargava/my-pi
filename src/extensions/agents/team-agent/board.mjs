// @ts-check
/**
 * TUI board for a team session — replaces the `watch ... json.tool`
 * that used to run in the `board` tmux window.
 *
 * Pure Node ESM, no dependencies, one file: the launcher invokes it
 * as `node board.mjs <queuePath>` and it runs forever, re-rendering
 * on every queue write (via fs.watch on the parent dir — writeQueue
 * does an atomic tmp+rename so the parent dir is where the event
 * lands) plus a ~1s fallback timer so a missed event can't freeze
 * the display.
 *
 * The renderBoard function is exported for unit tests to import.
 * Everything else (loop, colours, file I/O) lives in this file too
 * so the board never needs transpilation or additional deps.
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

/** Minimal ANSI helpers. No-op when the stream isn't a TTY or NO_COLOR set. */
function makeColorizer(enabled) {
  const wrap = (code) => (s) => enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    green: wrap("32"),
    yellow: wrap("33"),
    blue: wrap("34"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    grey: wrap("90"),
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Width to target for section rules when none is given. */
const DEFAULT_COLS = 80;

/** How many recently-closed tasks to show under the Closed section. */
const RECENT_CLOSED_LIMIT = 5;

/**
 * Render the full board for a queue. Pure function: no I/O, no timers.
 *
 * @param {{
 *   teamId: string,
 *   goal: string,
 *   targetBranch: string,
 *   tmuxSession: string,
 *   createdAt: number,
 *   updatedAt: number,
 *   tasks: Array<{
 *     id: string, title: string, status: string, addedBy: string,
 *     assignedTo?: string, attempts: number, feedback?: string,
 *     updatedAt: number, result?: string,
 *   }>,
 *   closed: Array<{ id: string, title: string, closedBy: string, attempts: number, closedAt: number }>,
 * }} queue
 * @param {{ color?: boolean, cols?: number, now?: Date }} [opts]
 * @returns {string}
 */
export function renderBoard(queue, opts = {}) {
  const color = opts.color ?? true;
  const cols = Math.max(40, opts.cols ?? DEFAULT_COLS);
  const now = opts.now ?? new Date();
  const c = makeColorizer(color);

  const out = [];

  // Header band — goal, id, target branch, session name
  out.push(c.bold(`Team: ${truncate(queue.goal, cols - 8)}`));
  out.push(c.dim(
    `ID: ${queue.teamId}   Target: ${queue.targetBranch}   Tmux: ${queue.tmuxSession}`,
  ));
  out.push("");

  // Count strip
  const queued = queue.tasks.filter((t) => t.status === "queued");
  const active = queue.tasks.filter((t) => t.status === "active");
  const review = queue.tasks.filter((t) => t.status === "review");
  out.push(
    [
      c.blue("Active")   + ` ${active.length}`,
      c.yellow("Review") + ` ${review.length}`,
      c.cyan("Queued")   + ` ${queued.length}`,
      c.grey("Closed")   + ` ${queue.closed.length}`,
    ].join("   "),
  );
  out.push("");

  // Sections — Active first because it's the most informative
  out.push(sectionHeader(c.blue("Active"), active.length, cols, c));
  if (active.length === 0) {
    out.push(c.dim("  (none)"));
  } else {
    for (const t of active) out.push(...renderActive(t, c, now, cols));
  }
  out.push("");

  out.push(sectionHeader(c.yellow("Review"), review.length, cols, c));
  if (review.length === 0) {
    out.push(c.dim("  (none)"));
  } else {
    for (const t of review) out.push(...renderReview(t, c, now, cols));
  }
  out.push("");

  out.push(sectionHeader(c.cyan("Queued"), queued.length, cols, c));
  if (queued.length === 0) {
    out.push(c.dim("  (none)"));
  } else {
    for (const t of queued) out.push(...renderQueued(t, c, cols));
  }
  out.push("");

  const closed = queue.closed.slice(-RECENT_CLOSED_LIMIT).reverse();
  out.push(sectionHeader(
    c.grey(`Recently closed`),
    `${closed.length} of ${queue.closed.length}`,
    cols, c,
  ));
  if (closed.length === 0) {
    out.push(c.dim("  (none)"));
  } else {
    for (const t of closed) out.push(...renderClosed(t, c, cols));
  }
  out.push("");

  // Footer
  out.push(c.dim("─".repeat(cols)));
  out.push(c.dim(
    `Queue updated: ${formatTimestamp(queue.updatedAt)}   `
    + `Rendered: ${formatTime(now)}   `
    + `Refresh: live (fs.watch + 1s)`,
  ));

  return out.join("\n");
}

/**
 * Section header: `Name (count) ─────────`
 *
 * @param {string} label
 * @param {string | number} count
 * @param {number} cols
 * @param {ReturnType<typeof makeColorizer>} c
 */
function sectionHeader(label, count, cols, c) {
  const prefix = `${label} (${count}) `;
  const plainWidth = stripAnsi(prefix).length;
  const ruleWidth = Math.max(3, cols - plainWidth);
  return prefix + c.dim("─".repeat(ruleWidth));
}

function renderActive(task, c, now, cols) {
  const age = formatElapsed(now.getTime() - task.updatedAt);
  const attempts = task.attempts > 1 ? `  ${c.yellow(`(attempt ${task.attempts})`)}` : "";
  return [
    `  ${c.dim(task.id)}  ${truncate(task.title, cols - 10)}`,
    c.dim(`        → ${task.assignedTo ?? "(unassigned)"}   dispatched ${age} ago`) + attempts,
  ];
}

function renderReview(task, c, now, cols) {
  const age = formatElapsed(now.getTime() - task.updatedAt);
  return [
    `  ${c.dim(task.id)}  ${truncate(task.title, cols - 10)}`,
    c.dim(`        completed by ${task.assignedTo ?? "(unknown)"}   ${age} ago   awaiting evaluator`),
  ];
}

function renderQueued(task, c, cols) {
  const lines = [`  ${c.dim(task.id)}  ${truncate(task.title, cols - 10)}`];
  const meta = [`added by ${task.addedBy}`];
  if (task.attempts > 0) meta.push(`${task.attempts} prior attempt(s)`);
  if (task.feedback) {
    lines.push(c.dim(`        ${meta.join("  ·  ")}`));
    lines.push(c.yellow("        ↻ feedback: ") + truncate(task.feedback, cols - 20));
  } else {
    lines.push(c.dim(`        ${meta.join("  ·  ")}`));
  }
  return lines;
}

function renderClosed(task, c, cols) {
  return [
    `  ${c.dim(task.id)}  ${truncate(task.title, cols - 10)}`,
    c.dim(`        closed by ${task.closedBy}   ${task.attempts} attempt(s)   ${formatTimestamp(task.closedAt)}`),
  ];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

/** ISO timestamp → `YYYY-MM-DD HH:MM:SS`. */
function formatTimestamp(ms) {
  return formatTime(new Date(ms));
}

function formatTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Millisecond duration → "3m 12s" etc. */
function formatElapsed(ms) {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Strip ANSI codes for width calculations. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// CLI loop
// ---------------------------------------------------------------------------

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const FALLBACK_REFRESH_MS = 1000;

async function readQueue(queuePath) {
  try {
    const raw = await readFile(queuePath, "utf-8");
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function currentCols() {
  // tmux pane sizes show up on stdout as `columns`; default if detached.
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : DEFAULT_COLS;
}

function shouldColor() {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

async function renderOnce(queuePath) {
  const result = await readQueue(queuePath);
  const color = shouldColor();
  const cols = currentCols();
  process.stdout.write(CLEAR_SCREEN);
  if (!result.ok) {
    const c = makeColorizer(color);
    process.stdout.write(c.dim(`Waiting for queue at ${queuePath}...\n`));
    process.stdout.write(c.dim(`(${result.error})\n`));
    return;
  }
  process.stdout.write(renderBoard(result.value, { color, cols }) + "\n");
}

function runLoop(queuePath) {
  process.stdout.write(HIDE_CURSOR);
  const restore = () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);

  let pending = false;
  let timer = null;

  const schedule = () => {
    if (pending) return;
    pending = true;
    // Coalesce bursts of fs.watch events (atomic rename fires
    // multiple rename events in quick succession).
    setImmediate(async () => {
      pending = false;
      await renderOnce(queuePath);
    });
  };

  // fs.watch on the parent dir catches the tmp→rename atomic write
  // pattern reliably across platforms. If watch can't be set up
  // (e.g. the dir doesn't exist yet), we fall back to the timer.
  try {
    const dir = path.dirname(queuePath);
    const base = path.basename(queuePath);
    const watcher = watch(dir, { persistent: false }, (_event, name) => {
      if (name === base) schedule();
    });
    process.on("exit", () => watcher.close());
  } catch {
    // Swallow — fallback timer will drive renders.
  }

  // Re-render on pane resize so the section rules and truncation
  // track the new width.
  process.stdout.on("resize", schedule);

  // Fallback periodic refresh. Catches missed fs events (network
  // filesystems, platform quirks) and refreshes elapsed-time
  // displays even when the queue hasn't changed.
  timer = setInterval(schedule, FALLBACK_REFRESH_MS);
  process.on("exit", () => { if (timer) clearInterval(timer); });

  // Kick off the first render immediately.
  schedule();
}

// Only run the loop when invoked as a script — not when imported
// from tests that only need the renderer.
const invokedDirectly = fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const queuePath = process.argv[2];
  if (!queuePath) {
    process.stderr.write("Usage: node board.mjs <queuePath>\n");
    process.exit(2);
  }
  runLoop(queuePath);
}
