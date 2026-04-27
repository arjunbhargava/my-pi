/**
 * Unit tests for src/lib/slack-inbound.ts
 *
 * Tests parseInboundMessage and filterNewMessages with all edge cases.
 *
 * Run: npx tsx tests/slack-inbound.test.ts
 */

import { strict as assert } from "node:assert";

import {
  filterNewMessages,
  parseInboundMessage,
} from "../src/lib/slack-inbound.js";
import type { SlackMessage } from "../src/lib/slack.js";

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// parseInboundMessage tests
// ---------------------------------------------------------------------------

test("team source → add_task with first line as title and full text as description", () => {
  const action = parseInboundMessage({
    source: { type: "team" },
    text: "Build the login page\nUse React and Tailwind. Must support OAuth.",
  });
  assert.equal(action.kind, "add_task");
  if (action.kind !== "add_task") return;
  assert.equal(action.title, "Build the login page");
  assert.equal(action.description, "Build the login page\nUse React and Tailwind. Must support OAuth.");
});

test("task source → feedback with correct taskId and text", () => {
  const action = parseInboundMessage({
    source: { type: "task", taskId: "abc123" },
    text: "Please also add error handling",
  });
  assert.equal(action.kind, "feedback");
  if (action.kind !== "feedback") return;
  assert.equal(action.taskId, "abc123");
  assert.equal(action.text, "Please also add error handling");
});

test("multi-line team message → title is first line only", () => {
  const action = parseInboundMessage({
    source: { type: "team" },
    text: "Fix the regression in auth\nLine 2\nLine 3",
  });
  assert.equal(action.kind, "add_task");
  if (action.kind !== "add_task") return;
  assert.equal(action.title, "Fix the regression in auth");
});

// ---------------------------------------------------------------------------
// filterNewMessages tests
// ---------------------------------------------------------------------------

const BOT_ID = "UBOT001";

function msg(ts: string, user?: string, botId?: string): SlackMessage {
  return { ts, text: `msg at ${ts}`, user, botId };
}

test("filterNewMessages filters out messages from bot user ID", () => {
  const messages = [
    msg("100", BOT_ID),
    msg("101", "UHUMAN"),
  ];
  const result = filterNewMessages(messages, undefined, BOT_ID);
  assert.equal(result.length, 1);
  assert.equal(result[0].ts, "101");
});

test("filterNewMessages filters out messages with bot_id field", () => {
  const messages = [
    msg("100", "UOTHER", "B001"),
    msg("101", "UHUMAN"),
  ];
  const result = filterNewMessages(messages, undefined, BOT_ID);
  assert.equal(result.length, 1);
  assert.equal(result[0].ts, "101");
});

test("filterNewMessages returns only messages newer than lastSeenTs", () => {
  const messages = [
    msg("100", "UHUMAN"),
    msg("101", "UHUMAN"),
    msg("102", "UHUMAN"),
  ];
  const result = filterNewMessages(messages, "101", BOT_ID);
  assert.equal(result.length, 1);
  assert.equal(result[0].ts, "102");
});

test("filterNewMessages with undefined lastSeenTs returns all non-bot messages", () => {
  const messages = [
    msg("100", "UHUMAN"),
    msg("101", BOT_ID),
    msg("102", "UOTHER", "B002"),
    msg("103", "UHUMAN2"),
  ];
  const result = filterNewMessages(messages, undefined, BOT_ID);
  assert.equal(result.length, 2);
  assert.equal(result[0].ts, "100");
  assert.equal(result[1].ts, "103");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    try {
      t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("slack-inbound tests:\n");
run();
