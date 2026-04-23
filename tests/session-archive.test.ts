/**
 * Unit tests for src/lib/session-archive.ts
 *
 * Exercises the cwd-to-session-dir slug (must match pi's own slug),
 * session-file listing with mtime ordering, and the jsonl → text
 * transcript renderer with realistic fixture content.
 *
 * Run: npx tsx tests/session-archive.test.ts
 */

import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import {
  listSessionFiles,
  parseSessionStartMs,
  renderSessionToText,
  sessionDirForCwd,
} from "../src/lib/session-archive.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// sessionDirForCwd
// ---------------------------------------------------------------------------

test("sessionDirForCwd matches pi's --path-- slug algorithm", async () => {
  const cwd = "/Users/alice/Projects/test-team-worktrees/team-abc/worker-xyz";
  const expected = path.join(
    homedir(),
    ".pi",
    "agent",
    "sessions",
    "--Users-alice-Projects-test-team-worktrees-team-abc-worker-xyz--",
  );
  assert.equal(sessionDirForCwd(cwd), expected);
});

test("sessionDirForCwd handles root cwd", async () => {
  const result = sessionDirForCwd("/");
  assert.ok(result.endsWith("----"), `got ${result}`);
});

// ---------------------------------------------------------------------------
// parseSessionStartMs
// ---------------------------------------------------------------------------

test("parseSessionStartMs decodes pi's filesystem-safe ISO prefix", async () => {
  const ms = parseSessionStartMs(
    "/x/y/2026-04-23T18-23-45-778Z_019dbb95-6e72-738e-a335-009b4dde3766.jsonl",
  );
  assert.equal(ms, Date.parse("2026-04-23T18:23:45.778Z"));
});

test("parseSessionStartMs returns null for non-pi filenames", async () => {
  assert.equal(parseSessionStartMs("/tmp/random.jsonl"), null);
  assert.equal(parseSessionStartMs("/tmp/2026-04-23_session.jsonl"), null);
});

// ---------------------------------------------------------------------------
// listSessionFiles
// ---------------------------------------------------------------------------

test("listSessionFiles returns newest first and ignores non-jsonl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-archive-test-"));
  try {
    const older = path.join(dir, "old.jsonl");
    const newer = path.join(dir, "new.jsonl");
    const notes = path.join(dir, "notes.txt");
    await writeFile(older, "");
    await writeFile(newer, "");
    await writeFile(notes, "");

    // Push the older file back in time so mtime ordering is unambiguous.
    const past = new Date(Date.now() - 60_000);
    await utimes(older, past, past);

    const files = await listSessionFiles(dir);
    assert.equal(files.length, 2, "only jsonl files counted");
    assert.equal(files[0].path, newer, "newest first");
    assert.equal(files[1].path, older);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listSessionFiles returns [] for missing directory", async () => {
  const files = await listSessionFiles("/nonexistent/session/dir");
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// renderSessionToText
// ---------------------------------------------------------------------------

test("renderSessionToText renders a realistic session end-to-end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-archive-test-"));
  const jsonl = path.join(dir, "session.jsonl");
  try {
    const entries = [
      { type: "session", id: "sess-1", cwd: "/tmp/worker", timestamp: "2026-04-23T18:00:00.000Z" },
      { type: "model_change", modelId: "us.anthropic.claude-sonnet-4-6", timestamp: "2026-04-23T18:00:01.000Z" },
      { type: "thinking_level_change", thinkingLevel: "medium", timestamp: "2026-04-23T18:00:01.010Z" },
      {
        type: "custom_message",
        customType: "team-context",
        content: "Team context block\nTeam: fix the bug",
        display: false,
        timestamp: "2026-04-23T18:00:02.000Z",
      },
      {
        type: "message",
        timestamp: "2026-04-23T18:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "please read the queue" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-04-23T18:00:04.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "I should look at the queue",
              thinkingSignature: "AAAA_huge_signature",
            },
            { type: "text", text: "Reading the queue." },
            {
              type: "toolCall",
              id: "call-1",
              name: "read_queue",
              arguments: { taskId: "abc123" },
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "2026-04-23T18:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_queue",
          content: [{ type: "text", text: "Task: fix the bug\nStatus: queued" }],
          isError: false,
        },
      },
      {
        type: "message",
        timestamp: "2026-04-23T18:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "permission denied" }],
          isError: true,
        },
      },
    ];
    await writeFile(jsonl, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const out = await renderSessionToText(jsonl);

    assert.match(out, /=== session sess-1 ===/);
    assert.match(out, /cwd: \/tmp\/worker/);
    assert.match(out, /MODEL → us\.anthropic\.claude-sonnet-4-6/);
    assert.match(out, /CONTEXT: team-context/);
    assert.match(out, /Team context block/);
    assert.match(out, /USER/);
    assert.match(out, /please read the queue/);
    assert.match(out, /ASSISTANT/);
    assert.match(out, /Reading the queue\./);
    assert.match(out, /\[tool_call: read_queue\] \{"taskId":"abc123"\}/);
    assert.match(out, /TOOL_RESULT: read_queue/);
    assert.match(out, /TOOL_RESULT: bash \[ERROR\]/);
    assert.match(out, /permission denied/);

    // Thinking blocks and their signatures must be dropped from the
    // transcript — they dwarf everything else and carry no value for
    // a human reader.
    assert.doesNotMatch(out, /I should look at the queue/);
    assert.doesNotMatch(out, /AAAA_huge_signature/);
    assert.doesNotMatch(out, /thinking_level_change/);

    // Human-readable timestamps are preferred over the raw ISO in
    // turn headers, but the session header keeps the full ISO for
    // traceability.
    assert.match(out, /\[2026-04-23 \d{2}:\d{2}:\d{2}\] USER/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderSessionToText tolerates malformed lines", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-archive-test-"));
  const jsonl = path.join(dir, "session.jsonl");
  try {
    const valid = JSON.stringify({
      type: "message",
      timestamp: "2026-04-23T18:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await writeFile(jsonl, `${valid}\nnot json at all\n${valid}\n`);
    const out = await renderSessionToText(jsonl);
    assert.match(out, /\[unparseable line\]/);
    assert.ok(out.split("USER").length - 1 >= 2, "both valid messages still rendered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderSessionToText truncates long tool results", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "session-archive-test-"));
  const jsonl = path.join(dir, "session.jsonl");
  try {
    const longBody = "x".repeat(5_000);
    const entry = {
      type: "message",
      timestamp: "2026-04-23T18:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: longBody }],
      },
    };
    await writeFile(jsonl, JSON.stringify(entry) + "\n");
    const out = await renderSessionToText(jsonl);
    assert.match(out, /truncated \d+ chars/);
    assert.ok(out.length < longBody.length, "rendered output shorter than raw body");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("session-archive tests:\n");
run();
