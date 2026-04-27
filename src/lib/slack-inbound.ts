/**
 * Inbound message parsing for the Slack bridge.
 *
 * Pure parsing logic — no I/O, no Slack API calls, no queue mutations.
 * Maps Slack message text to typed queue actions based on where the
 * message came from (team thread vs. worker/task thread).
 */

import type { SlackMessage } from "./slack.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackAction =
  | { kind: "add_task"; title: string; description: string }
  | { kind: "feedback"; taskId: string; text: string }
  | { kind: "unknown"; text: string };

export interface InboundContext {
  /** Which thread the message came from: "team" or a taskId */
  source: { type: "team" } | { type: "task"; taskId: string };
  /** The Slack message text */
  text: string;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Parse an inbound Slack message into a typed queue action.
 *
 * Team thread messages become add_task actions (first line is title).
 * Task thread messages become feedback actions on the corresponding task.
 *
 * @param ctx - Source context (team or task thread) and raw message text.
 * @returns A typed SlackAction describing what should happen to the queue.
 */
export function parseInboundMessage(ctx: InboundContext): SlackAction {
  if (ctx.source.type === "team") {
    const title = ctx.text.split("\n")[0].trim();
    return { kind: "add_task", title, description: ctx.text };
  }
  return { kind: "feedback", taskId: ctx.source.taskId, text: ctx.text };
}

/**
 * Filter a list of Slack messages down to those that are new and not from bots.
 *
 * @param messages - Messages from a conversations.replies call.
 * @param lastSeenTs - Timestamp of the last message already processed (exclusive lower bound).
 *                     When undefined, all non-bot messages are returned.
 * @param botUserId - The bot's own Slack user ID; messages from this user are excluded.
 * @returns Messages that are newer than lastSeenTs and not authored by any bot.
 */
export function filterNewMessages(
  messages: SlackMessage[],
  lastSeenTs: string | undefined,
  botUserId: string,
): SlackMessage[] {
  return messages.filter((msg) => {
    if (msg.user === botUserId) return false;
    if (msg.botId !== undefined) return false;
    if (lastSeenTs !== undefined && msg.ts <= lastSeenTs) return false;
    return true;
  });
}
