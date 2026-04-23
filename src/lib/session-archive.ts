/**
 * Helpers for reading pi's on-disk session archive at
 * `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`.
 *
 * pi already records every message, tool call, and tool result for
 * each interactive session to a jsonl file keyed by the cwd of the
 * running agent. This module resolves a cwd to its session directory,
 * lists the jsonl files in mtime order, and renders a single jsonl
 * into a human-readable transcript (used by `/team-logs`).
 *
 * No pi imports — pure node stdlib + our own types.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches pi's session-dir placement under the user's home directory. */
const PI_AGENT_DIR = path.join(".pi", "agent", "sessions");

/** Max characters shown for any single tool-result body. */
const TOOL_RESULT_TRUNCATE = 800;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into the directory name pi uses for its session archive.
 * Mirrors `getDefaultSessionDir` in pi-coding-agent's session-manager:
 * strip a leading separator, replace separators and colons with `-`,
 * wrap in `--...--`.
 */
export function sessionDirForCwd(cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(homedir(), PI_AGENT_DIR, safe);
}

export interface SessionFile {
  /** Absolute path to the .jsonl file. */
  path: string;
  /** mtime in ms. */
  mtimeMs: number;
  /**
   * Start time parsed from pi's filename (`YYYY-MM-DDTHH-MM-SS-mmmZ_...`).
   * Null if the filename doesn't match that shape.
   */
  startMs: number | null;
}

/**
 * pi session filenames encode the start time in a filesystem-safe
 * variant of ISO 8601 — colons in the time part are replaced with
 * dashes. Reverse that to recover the real instant.
 */
export function parseSessionStartMs(jsonlPath: string): number | null {
  const name = path.basename(jsonlPath);
  const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  const iso = `${date}T${hh}:${mm}:${ss}.${ms}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * List `.jsonl` files in a session directory, newest first. Returns an
 * empty list if the directory doesn't exist or isn't readable — a
 * valid state for agents that never booted.
 */
export async function listSessionFiles(sessionDir: string): Promise<SessionFile[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(sessionDir, name);
    try {
      const st = await stat(full);
      if (st.isFile()) {
        files.push({ path: full, mtimeMs: st.mtimeMs, startMs: parseSessionStartMs(full) });
      }
    } catch {
      // Skip files that vanished between readdir and stat.
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Parsed jsonl entry. Only the fields we actually render are typed —
 * the rest flow through as `unknown` and are ignored.
 */
interface JsonlEntry {
  type: string;
  timestamp?: string;
  // session
  id?: string;
  cwd?: string;
  // model_change
  modelId?: string;
  // custom_message
  customType?: string;
  content?: unknown;
  display?: boolean;
  // message
  message?: {
    role?: "user" | "assistant" | "toolResult";
    content?: Array<Record<string, unknown>>;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
  };
}

/**
 * Read a pi session jsonl file and render it as a plain-text
 * transcript. The output is designed to be grep-friendly: one header
 * per turn with an ISO-ish timestamp + role, followed by the body.
 * Thinking blocks are dropped (noisy signatures, huge content);
 * assistant text, user text, tool calls, and tool results are kept.
 */
export async function renderSessionToText(jsonlPath: string): Promise<string> {
  const raw = await readFile(jsonlPath, "utf-8");
  const lines = raw.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      out.push(`[unparseable line] ${line.slice(0, 200)}`);
      continue;
    }

    const ts = formatTimestamp(entry.timestamp);
    renderEntry(entry, ts, out);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function renderEntry(entry: JsonlEntry, ts: string, out: string[]): void {
  switch (entry.type) {
    case "session":
      out.push(`=== session ${entry.id ?? "(unknown id)"} ===`);
      if (entry.cwd) out.push(`cwd: ${entry.cwd}`);
      if (entry.timestamp) out.push(`started: ${entry.timestamp}`);
      out.push("");
      return;

    case "model_change":
      if (entry.modelId) out.push(`[${ts}] MODEL → ${entry.modelId}\n`);
      return;

    case "thinking_level_change":
      // Uninteresting for a transcript reader.
      return;

    case "custom_message":
      // Display-suppressed context blocks (like team-context) carry
      // useful system state for the agent; render them as CONTEXT.
      if (typeof entry.content === "string" && entry.content.trim()) {
        out.push(`[${ts}] CONTEXT${entry.customType ? `: ${entry.customType}` : ""}`);
        out.push(entry.content.trim());
        out.push("");
      }
      return;

    case "message":
      renderMessage(entry, ts, out);
      return;

    default:
      // Forward-compatible: unknown types don't break the render.
      out.push(`[${ts}] [${entry.type}]`);
      out.push("");
  }
}

function renderMessage(entry: JsonlEntry, ts: string, out: string[]): void {
  const msg = entry.message;
  if (!msg) return;
  const role = msg.role;
  const content = Array.isArray(msg.content) ? msg.content : [];

  if (role === "toolResult") {
    const toolName = msg.toolName ?? "(unknown)";
    const errTag = msg.isError ? " [ERROR]" : "";
    out.push(`[${ts}] TOOL_RESULT: ${toolName}${errTag}`);
    out.push(truncate(extractTextContent(content), TOOL_RESULT_TRUNCATE));
    out.push("");
    return;
  }

  if (role === "user") {
    out.push(`[${ts}] USER`);
    out.push(extractTextContent(content));
    out.push("");
    return;
  }

  if (role === "assistant") {
    out.push(`[${ts}] ASSISTANT`);
    for (const part of content) {
      const partType = typeof part.type === "string" ? part.type : "";
      if (partType === "text" && typeof part.text === "string") {
        out.push(part.text);
      } else if (partType === "toolCall") {
        const name = typeof part.name === "string" ? part.name : "(unknown)";
        const args = safeJsonInline(part.arguments);
        out.push(`[tool_call: ${name}] ${args}`);
      }
      // Thinking blocks intentionally dropped.
    }
    out.push("");
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Truncate a string with a clear marker so the reader knows it was cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/** Pull plain-text bodies out of a content-part array. */
function extractTextContent(parts: Array<Record<string, unknown>>): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

/** Serialize tool arguments in a single line, falling back on String(). */
function safeJsonInline(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s ?? String(value);
  } catch {
    return String(value);
  }
}

/** Convert an ISO timestamp to `YYYY-MM-DD HH:MM:SS`, or an empty string. */
function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
