/**
 * Slack Web API client using native fetch (no dependencies).
 *
 * All operations return `Result<T>` per project convention. Failures cover
 * non-2xx HTTP status, Slack API-level errors (`ok: false`), and network
 * exceptions.
 */

import type { Result } from "./types.js";

// ---------------------------------------------------------------------------
// Block Kit types (minimal subset)
// ---------------------------------------------------------------------------

/** Mrkdwn-formatted text element. */
export interface MrkdwnText {
  type: "mrkdwn";
  text: string;
}

/** Plain-text element. */
export interface PlainText {
  type: "plain_text";
  text: string;
}

/** Section block with an optional accessory. */
export interface SectionBlock {
  type: "section";
  text: MrkdwnText;
  accessory?: unknown;
}

/** Header block. */
export interface HeaderBlock {
  type: "header";
  text: PlainText;
}

/** Divider block. */
export interface DividerBlock {
  type: "divider";
}

/** Context block holding text elements. */
export interface ContextBlock {
  type: "context";
  elements: (MrkdwnText | PlainText)[];
}

/** Union of supported Block Kit block types. */
export type SlackBlock =
  | SectionBlock
  | HeaderBlock
  | DividerBlock
  | ContextBlock;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Credentials and target channel for all Slack API calls.
 * Read from environment at the call site — this module never reads env vars.
 */
export interface SlackConfig {
  /** Bot token with `chat:write` and `channels:history` scopes. */
  botToken: string;
  /** Slack channel ID (e.g. `C01ABC123`). */
  channelId: string;
}

/** Options for sending a message. */
export interface PostMessageOptions {
  /** Fallback text (required by Slack even when blocks are provided). */
  text: string;
  /** Optional Block Kit payload. */
  blocks?: SlackBlock[];
  /** When set, posts as a reply in this thread. */
  threadTs?: string;
}

/** Minimal message fields returned after a successful post. */
export interface SlackPostResult {
  /** Message timestamp — used as the thread identifier. */
  ts: string;
  /** Channel the message was posted to. */
  channelId: string;
}

/** A single message from conversations.replies or conversations.history. */
export interface SlackMessage {
  /** Message timestamp. */
  ts: string;
  /** Message text. */
  text: string;
  /** Slack user ID, present on human-authored messages. */
  user?: string;
  /** Bot ID, present on bot-authored messages. */
  botId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api";

function authHeaders(botToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${botToken}`,
    "Content-Type": "application/json",
  };
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

interface PostMessageResponse extends SlackApiResponse {
  channel?: string;
  message?: { ts?: string };
}

interface ConversationsResponse extends SlackApiResponse {
  messages?: Array<{
    ts: string;
    text: string;
    user?: string;
    bot_id?: string;
  }>;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Post a message to the configured channel.
 *
 * @param config - Bot token and channel ID.
 * @param options - Message text, optional blocks, and optional thread timestamp.
 * @returns The timestamp and channel of the posted message, or an error.
 */
export async function postMessage(
  config: SlackConfig,
  options: PostMessageOptions,
): Promise<Result<SlackPostResult>> {
  const body: Record<string, unknown> = {
    channel: config.channelId,
    text: options.text,
  };
  if (options.blocks !== undefined) body.blocks = options.blocks;
  if (options.threadTs !== undefined) body.thread_ts = options.threadTs;

  let response: Response;
  try {
    response = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(config.botToken),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }

  const data = (await response.json()) as PostMessageResponse;
  if (!data.ok) {
    return { ok: false, error: data.error ?? "unknown_error" };
  }

  const ts = data.message?.ts;
  if (!ts) {
    return { ok: false, error: "missing ts in response" };
  }

  return { ok: true, value: { ts, channelId: data.channel ?? config.channelId } };
}

/**
 * Fetch replies in a message thread.
 *
 * @param config - Bot token and channel ID.
 * @param threadTs - Timestamp of the parent message.
 * @param options - Optional `oldest` timestamp to filter incremental replies.
 * @returns Array of messages in the thread, or an error.
 */
export async function getConversationReplies(
  config: SlackConfig,
  threadTs: string,
  options?: { oldest?: string },
): Promise<Result<SlackMessage[]>> {
  const query = buildQuery({
    channel: config.channelId,
    ts: threadTs,
    oldest: options?.oldest,
  });

  let response: Response;
  try {
    response = await fetch(`${SLACK_API}/conversations.replies${query}`, {
      headers: authHeaders(config.botToken),
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }

  const data = (await response.json()) as ConversationsResponse;
  if (!data.ok) {
    return { ok: false, error: data.error ?? "unknown_error" };
  }

  const messages = (data.messages ?? []).map((m) => ({
    ts: m.ts,
    text: m.text,
    user: m.user,
    botId: m.bot_id,
  }));

  return { ok: true, value: messages };
}

/**
 * Fetch recent messages from the configured channel.
 *
 * @param config - Bot token and channel ID.
 * @param options - Optional `oldest` timestamp and `limit` for pagination.
 * @returns Array of messages, or an error.
 */
export async function getConversationHistory(
  config: SlackConfig,
  options?: { oldest?: string; limit?: number },
): Promise<Result<SlackMessage[]>> {
  const query = buildQuery({
    channel: config.channelId,
    oldest: options?.oldest,
    limit: options?.limit !== undefined ? String(options.limit) : undefined,
  });

  let response: Response;
  try {
    response = await fetch(`${SLACK_API}/conversations.history${query}`, {
      headers: authHeaders(config.botToken),
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }

  const data = (await response.json()) as ConversationsResponse;
  if (!data.ok) {
    return { ok: false, error: data.error ?? "unknown_error" };
  }

  const messages = (data.messages ?? []).map((m) => ({
    ts: m.ts,
    text: m.text,
    user: m.user,
    botId: m.bot_id,
  }));

  return { ok: true, value: messages };
}
