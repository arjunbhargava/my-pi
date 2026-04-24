/**
 * Unit tests for src/extensions/agents/team-agent/board.mjs.
 *
 * The board is plain Node ESM so it runs in the tmux pane without a
 * transpile step. This test imports the `renderBoard` function
 * directly via dynamic import and checks the output shape against
 * fixture queues — sections, counts, feedback, truncation, colour
 * on/off, and the empty case.
 *
 * Run: npx tsx tests/board.test.ts
 */

import { strict as assert } from "node:assert";

// tsx resolves .mjs at runtime; we only care about the renderBoard export.
// Wrap the dynamic import in a main() function because tsx's CJS mode
// blocks top-level await.
type RenderBoard = (queue: unknown, opts?: {
  color?: boolean;
  cols?: number;
  now?: Date;
}) => string;

let renderBoard: RenderBoard;

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_TIME = Date.parse("2026-04-24T12:00:00Z");

function makeQueue(overrides: Partial<{
  goal: string;
  tasks: Array<Record<string, unknown>>;
  closed: Array<Record<string, unknown>>;
}> = {}): Record<string, unknown> {
  return {
    teamId: "bd531d57",
    goal: overrides.goal ?? "build a login flow with JWT",
    targetBranch: "main",
    tmuxSession: "pi-team-test",
    createdAt: BASE_TIME - 60_000,
    updatedAt: BASE_TIME,
    tasks: overrides.tasks ?? [],
    closed: overrides.closed ?? [],
    log: [],
  };
}

// Colour off by default so assertions can match plain text without
// dealing with ANSI escape codes.
const defaultOpts = { color: false, cols: 80, now: new Date(BASE_TIME) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders header band with goal, team id, target, tmux", () => {
  const out = renderBoard(makeQueue(), defaultOpts);
  assert.match(out, /Team: build a login flow with JWT/);
  assert.match(out, /ID: bd531d57/);
  assert.match(out, /Target: main/);
  assert.match(out, /Tmux: pi-team-test/);
});

test("counts strip reflects task statuses and closed length", () => {
  const out = renderBoard(makeQueue({
    tasks: [
      { id: "aa", title: "Q1", status: "queued", addedBy: "orch", attempts: 0, updatedAt: BASE_TIME, createdAt: BASE_TIME },
      { id: "bb", title: "Q2", status: "queued", addedBy: "orch", attempts: 0, updatedAt: BASE_TIME, createdAt: BASE_TIME },
      { id: "cc", title: "A1", status: "active", addedBy: "orch", assignedTo: "worker-1", attempts: 1, updatedAt: BASE_TIME - 30_000, createdAt: BASE_TIME },
      { id: "dd", title: "R1", status: "review", addedBy: "orch", assignedTo: "worker-2", attempts: 1, updatedAt: BASE_TIME - 10_000, createdAt: BASE_TIME },
    ],
    closed: [
      { id: "ee", title: "old", closedBy: "evaluator", attempts: 1, closedAt: BASE_TIME - 100_000 },
      { id: "ff", title: "older", closedBy: "evaluator", attempts: 2, closedAt: BASE_TIME - 200_000 },
    ],
  }), defaultOpts);

  assert.match(out, /Active 1/);
  assert.match(out, /Review 1/);
  assert.match(out, /Queued 2/);
  assert.match(out, /Closed 2/);
});

test("active section shows assignee + elapsed", () => {
  const out = renderBoard(makeQueue({
    tasks: [{
      id: "abc123",
      title: "Add JWT verify middleware",
      status: "active",
      addedBy: "orchestrator",
      assignedTo: "worker-mobxy",
      attempts: 1,
      updatedAt: BASE_TIME - 75_000,
      createdAt: BASE_TIME - 120_000,
    }],
  }), defaultOpts);

  assert.match(out, /abc123/);
  assert.match(out, /Add JWT verify middleware/);
  assert.match(out, /→ worker-mobxy/);
  assert.match(out, /dispatched 1m 15s ago/);
});

test("active section flags multi-attempt tasks", () => {
  const out = renderBoard(makeQueue({
    tasks: [{
      id: "retryid",
      title: "Fix flaky test",
      status: "active",
      addedBy: "orchestrator",
      assignedTo: "worker-99",
      attempts: 3,
      updatedAt: BASE_TIME - 5_000,
      createdAt: BASE_TIME - 400_000,
    }],
  }), defaultOpts);
  assert.match(out, /attempt 3/);
});

test("review section notes awaiting-evaluator", () => {
  const out = renderBoard(makeQueue({
    tasks: [{
      id: "revid",
      title: "Typo fix",
      status: "review",
      addedBy: "code-reviewer",
      assignedTo: "worker-42",
      attempts: 1,
      updatedAt: BASE_TIME - 4_000,
      createdAt: BASE_TIME - 50_000,
    }],
  }), defaultOpts);
  assert.match(out, /Typo fix/);
  assert.match(out, /completed by worker-42/);
  assert.match(out, /awaiting evaluator/);
});

test("queued task with feedback shows the feedback line", () => {
  const out = renderBoard(makeQueue({
    tasks: [{
      id: "qid",
      title: "Document env vars",
      status: "queued",
      addedBy: "orchestrator",
      feedback: "Need to cover the expiry case in tests",
      attempts: 1,
      updatedAt: BASE_TIME - 2_000,
      createdAt: BASE_TIME - 60_000,
    }],
  }), defaultOpts);
  assert.match(out, /Document env vars/);
  assert.match(out, /feedback: Need to cover the expiry case/);
  assert.match(out, /1 prior attempt/);
});

test("recently-closed shows the last 5 newest-first with total", () => {
  const closed = Array.from({ length: 8 }, (_, i) => ({
    id: `c${i}`,
    title: `closed-${i}`,
    closedBy: "evaluator",
    attempts: 1,
    closedAt: BASE_TIME - (8 - i) * 1000,
  }));
  const out = renderBoard(makeQueue({ closed }), defaultOpts);
  assert.match(out, /Recently closed \(5 of 8\)/);
  // Newest closed (index 7) appears before older ones.
  const idxNewest = out.indexOf("closed-7");
  const idxOlder = out.indexOf("closed-3");
  assert.ok(idxNewest > 0 && idxOlder > idxNewest, "newest closed comes first");
  // Only 5 should be rendered.
  assert.ok(!out.includes("closed-0"), "closed-0 should be truncated");
});

test("empty queue renders sections with (none)", () => {
  const out = renderBoard(makeQueue(), defaultOpts);
  const noneMatches = out.match(/\(none\)/g);
  // Active, Review, Queued, Recently closed — four sections.
  assert.ok(noneMatches && noneMatches.length === 4, `expected 4 (none) markers, got ${noneMatches?.length}`);
});

test("long goal is truncated to fit the column width", () => {
  const longGoal = "x".repeat(400);
  const out = renderBoard(makeQueue({ goal: longGoal }), { ...defaultOpts, cols: 80 });
  // The rendered goal line must be bounded by the column width.
  const header = out.split("\n").find((line) => line.startsWith("Team: "));
  assert.ok(header, "header line present");
  assert.ok(header!.length <= 80, `header length ${header!.length} exceeds 80`);
});

test("color: true produces ANSI escapes; color: false does not", () => {
  const queue = makeQueue({
    tasks: [{
      id: "x", title: "t", status: "active", addedBy: "o",
      assignedTo: "w", attempts: 1, updatedAt: BASE_TIME, createdAt: BASE_TIME,
    }],
  });
  const colored = renderBoard(queue, { ...defaultOpts, color: true });
  const plain = renderBoard(queue, { ...defaultOpts, color: false });
  assert.ok(colored.includes("\x1b["), "coloured output has ANSI codes");
  assert.ok(!plain.includes("\x1b["), "plain output has no ANSI codes");
});

test("footer shows queue and render timestamps + refresh mode", () => {
  const out = renderBoard(makeQueue(), defaultOpts);
  assert.match(out, /Queue updated: 2026-04-24 \d{2}:\d{2}:\d{2}/);
  assert.match(out, /Rendered: 2026-04-24 \d{2}:\d{2}:\d{2}/);
  assert.match(out, /Refresh: live/);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const boardModule = await import("../src/extensions/agents/team-agent/board.mjs");
  renderBoard = boardModule.renderBoard as RenderBoard;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
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

main().catch((e) => { console.error(e); process.exit(1); });
