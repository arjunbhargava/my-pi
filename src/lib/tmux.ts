/**
 * Thin wrappers around tmux CLI commands.
 *
 * Every function accepts an {@link ExecContext} and returns a typed
 * {@link Result}. This is the only module that should invoke tmux
 * directly, mirroring the pattern established by git.ts.
 */

import type { ExecContext, ExecResult, Result } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TMUX_TIMEOUT_MS = 10_000;

/** Run a tmux command. */
async function execTmux(
  ctx: ExecContext,
  args: string[],
  timeoutMs: number = TMUX_TIMEOUT_MS,
): Promise<ExecResult> {
  return ctx.exec("tmux", args, { timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/** Check whether a tmux session with the given name exists. */
export async function sessionExists(
  ctx: ExecContext,
  name: string,
): Promise<Result<boolean>> {
  const result = await execTmux(ctx, ["has-session", "-t", name]);
  return { ok: true, value: result.code === 0 };
}

/**
 * Create a new detached tmux session.
 *
 * @param ctx  - Execution context.
 * @param name - Session name.
 * @param opts - Optional settings (initial window name, working directory).
 */
export async function createSession(
  ctx: ExecContext,
  name: string,
  opts?: { windowName?: string; cwd?: string },
): Promise<Result<void>> {
  const args = ["new-session", "-d", "-s", name];
  if (opts?.windowName) args.push("-n", opts.windowName);
  if (opts?.cwd) args.push("-c", opts.cwd);

  const result = await execTmux(ctx, args);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to create tmux session '${name}': ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/**
 * Create a new window in an existing tmux session.
 *
 * @param ctx         - Execution context.
 * @param session     - tmux session name.
 * @param windowName  - Name for the new window.
 * @param opts        - Optional shell command to run and working directory.
 */
export async function createWindow(
  ctx: ExecContext,
  session: string,
  windowName: string,
  opts?: { command?: string; cwd?: string },
): Promise<Result<void>> {
  const args = ["new-window", "-t", session, "-n", windowName];
  if (opts?.cwd) args.push("-c", opts.cwd);
  if (opts?.command) args.push(opts.command);

  const result = await execTmux(ctx, args);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to create window '${windowName}': ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Kill an entire tmux session and all its windows. */
export async function killSession(
  ctx: ExecContext,
  name: string,
): Promise<Result<void>> {
  const result = await execTmux(ctx, ["kill-session", "-t", name]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to kill tmux session '${name}': ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Window inspection
// ---------------------------------------------------------------------------

/** Parsed entry from `tmux list-windows`. */
export interface TmuxWindow {
  /** Window index. */
  index: number;
  /** Window name. */
  name: string;
  /** Whether this window is currently active. */
  isActive: boolean;
}

/** List all windows in a tmux session. */
export async function listWindows(
  ctx: ExecContext,
  session: string,
): Promise<Result<TmuxWindow[]>> {
  const result = await execTmux(ctx, [
    "list-windows", "-t", session,
    "-F", "#{window_index}\t#{window_name}\t#{window_active}",
  ]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to list windows: ${result.stderr.trim()}` };
  }

  const windows: TmuxWindow[] = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [index, name, active] = line.split("\t");
      return {
        index: parseInt(index, 10),
        name,
        isActive: active === "1",
      };
    });

  return { ok: true, value: windows };
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/**
 * Send keystrokes to a specific window in a tmux session.
 * Useful for injecting commands into a running shell.
 *
 * @param ctx     - Execution context.
 * @param session - tmux session name.
 * @param window  - Window name or index.
 * @param keys    - Keys to send (tmux key syntax).
 */
export async function sendKeys(
  ctx: ExecContext,
  session: string,
  window: string,
  keys: string,
): Promise<Result<void>> {
  const result = await execTmux(ctx, ["send-keys", "-t", `${session}:${window}`, keys, "Enter"]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to send keys: ${result.stderr.trim()}` };
  }
  return { ok: true, value: undefined };
}

/**
 * Capture the visible contents of a tmux pane.
 * Returns the text currently displayed in the window.
 *
 * @param ctx     - Execution context.
 * @param session - tmux session name.
 * @param window  - Window name or index.
 */
export async function capturePane(
  ctx: ExecContext,
  session: string,
  window: string,
): Promise<Result<string>> {
  const result = await execTmux(ctx, [
    "capture-pane", "-t", `${session}:${window}`, "-p",
  ]);
  if (result.code !== 0) {
    return { ok: false, error: `Failed to capture pane: ${result.stderr.trim()}` };
  }
  return { ok: true, value: result.stdout };
}
