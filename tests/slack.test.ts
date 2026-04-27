/**
 * Unit tests for src/lib/slack.ts
 *
 * Tests the Slack Web API client using a mocked globalThis.fetch.
 * No real network calls are made.
 *
 * Run: npx tsx tests/slack.test.ts
 */

import { strict as assert } from "node:assert";

import {
  getAuthTest,
  getConversationHistory,
  getConversationReplies,
  postMessage,
} from "../src/lib/slack.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

/** Replace globalThis.fetch with a mock for the duration of `fn`. */
async function withFetch(
  mock: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Build a minimal fetch mock that returns a JSON response. */
function jsonFetch(
  status: number,
  body: unknown,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_url, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

/** Capture request details alongside returning a JSON response. */
function capturingFetch(
  status: number,
  body: unknown,
): {
  mock: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: url.toString(), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { mock, calls };
}

const config = { botToken: "xoxb-test-token", channelId: "C0123456789" };

// ---------------------------------------------------------------------------
// postMessage tests
// ---------------------------------------------------------------------------

test("postMessage sends correct URL, headers, and body; returns ts and channelId", async () => {
  const { mock, calls } = capturingFetch(200, {
    ok: true,
    channel: "C0123456789",
    message: { ts: "1700000000.000001" },
  });

  await withFetch(mock as typeof fetch, async () => {
    const result = await postMessage(config, { text: "hello" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.ts, "1700000000.000001");
    assert.equal(result.value.channelId, "C0123456789");
  });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://slack.com/api/chat.postMessage");
  assert.equal(init?.method, "POST");

  const headers = init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer xoxb-test-token");
  assert.equal(headers["Content-Type"], "application/json");

  const parsed = JSON.parse(init?.body as string);
  assert.equal(parsed.channel, "C0123456789");
  assert.equal(parsed.text, "hello");
});

test("postMessage with threadTs includes thread_ts in request body", async () => {
  const { mock, calls } = capturingFetch(200, {
    ok: true,
    channel: "C0123456789",
    message: { ts: "1700000001.000001" },
  });

  await withFetch(mock as typeof fetch, async () => {
    const result = await postMessage(config, {
      text: "reply",
      threadTs: "1700000000.000001",
    });
    assert.ok(result.ok);
  });

  const parsed = JSON.parse(calls[0].init?.body as string);
  assert.equal(parsed.thread_ts, "1700000000.000001");
});

test("postMessage returns ok:false on non-200 HTTP status", async () => {
  await withFetch(jsonFetch(500, { ok: false }) as typeof fetch, async () => {
    const result = await postMessage(config, { text: "hello" });
    assert.ok(!result.ok);
    assert.ok(result.error.includes("500"));
  });
});

test("postMessage returns ok:false when Slack API returns ok:false", async () => {
  await withFetch(
    jsonFetch(200, { ok: false, error: "channel_not_found" }) as typeof fetch,
    async () => {
      const result = await postMessage(config, { text: "hello" });
      assert.ok(!result.ok);
      assert.equal(result.error, "channel_not_found");
    },
  );
});

// ---------------------------------------------------------------------------
// getConversationReplies tests
// ---------------------------------------------------------------------------

test("getConversationReplies sends correct query params and returns messages", async () => {
  const { mock, calls } = capturingFetch(200, {
    ok: true,
    messages: [
      { ts: "1700000000.000001", text: "first", user: "U001" },
      { ts: "1700000000.000002", text: "second", bot_id: "B001" },
    ],
  });

  await withFetch(mock as typeof fetch, async () => {
    const result = await getConversationReplies(
      config,
      "1700000000.000001",
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.equal(result.value[0].text, "first");
    assert.equal(result.value[0].user, "U001");
    assert.equal(result.value[1].botId, "B001");
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/conversations.replies");
  assert.equal(url.searchParams.get("channel"), "C0123456789");
  assert.equal(url.searchParams.get("ts"), "1700000000.000001");
});

test("getConversationReplies with oldest includes it in the URL", async () => {
  const { mock, calls } = capturingFetch(200, { ok: true, messages: [] });

  await withFetch(mock as typeof fetch, async () => {
    await getConversationReplies(config, "1700000000.000001", {
      oldest: "1700000000.000050",
    });
  });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("oldest"), "1700000000.000050");
});

// ---------------------------------------------------------------------------
// getConversationHistory tests
// ---------------------------------------------------------------------------

test("getConversationHistory sends correct query params and returns parsed messages", async () => {
  const { mock, calls } = capturingFetch(200, {
    ok: true,
    messages: [
      { ts: "1700000000.000001", text: "hello", user: "U001" },
      { ts: "1700000000.000002", text: "from bot", bot_id: "B001" },
    ],
  });

  await withFetch(mock as typeof fetch, async () => {
    const result = await getConversationHistory(config);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.equal(result.value[0].text, "hello");
    assert.equal(result.value[0].user, "U001");
    assert.equal(result.value[1].botId, "B001");
  });

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/conversations.history");
  assert.equal(url.searchParams.get("channel"), "C0123456789");
});

test("getConversationHistory with oldest includes it in the URL", async () => {
  const { mock, calls } = capturingFetch(200, { ok: true, messages: [] });

  await withFetch(mock as typeof fetch, async () => {
    await getConversationHistory(config, { oldest: "1700000000.000050" });
  });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("oldest"), "1700000000.000050");
});

test("getConversationHistory with limit includes it in the URL as a string", async () => {
  const { mock, calls } = capturingFetch(200, { ok: true, messages: [] });

  await withFetch(mock as typeof fetch, async () => {
    await getConversationHistory(config, { limit: 50 });
  });

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("limit"), "50");
});

test("getConversationHistory returns ok:false on non-200 HTTP status", async () => {
  await withFetch(jsonFetch(500, { ok: false }) as typeof fetch, async () => {
    const result = await getConversationHistory(config);
    assert.ok(!result.ok);
    assert.ok(result.error.includes("500"));
  });
});

test("getConversationHistory returns ok:false when Slack API returns ok:false", async () => {
  await withFetch(
    jsonFetch(200, { ok: false, error: "not_in_channel" }) as typeof fetch,
    async () => {
      const result = await getConversationHistory(config);
      assert.ok(!result.ok);
      assert.equal(result.error, "not_in_channel");
    },
  );
});

// ---------------------------------------------------------------------------
// getAuthTest tests
// ---------------------------------------------------------------------------

test("getAuthTest sends Authorization header and returns userId and teamId", async () => {
  const { mock, calls } = capturingFetch(200, {
    ok: true,
    user_id: "UBOT001",
    team_id: "T0123",
  });

  await withFetch(mock as typeof fetch, async () => {
    const result = await getAuthTest("xoxb-test-token");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.value.userId, "UBOT001");
    assert.equal(result.value.teamId, "T0123");
  });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://slack.com/api/auth.test");
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer xoxb-test-token");
});

// ---------------------------------------------------------------------------
// Network error test
// ---------------------------------------------------------------------------

test("network error (fetch throws) returns ok:false", async () => {
  const throwingFetch = async (): Promise<Response> => {
    throw new Error("ECONNREFUSED");
  };

  await withFetch(throwingFetch as unknown as typeof fetch, async () => {
    const result = await postMessage(config, { text: "hello" });
    assert.ok(!result.ok);
    assert.ok(result.error.includes("ECONNREFUSED"));
  });
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
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("slack tests:\n");
run();
