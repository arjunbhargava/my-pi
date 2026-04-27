/**
 * Inbound polling for the Slack bridge.
 *
 * Reads Slack threads for new user messages and applies them to the queue:
 * - feedback on task threads → appended to task.feedback
 * - add_task commands on the team thread → new task inserted into the queue
 *
 * Also exports withQueueFileLock, used here and wirable from the bridge script.
 */

import * as lockfile from "proper-lockfile";

import type { TaskQueue } from "./types.js";
import type { ThreadState } from "./slack-threads.js";
import { getConversationReplies } from "./slack.js";
import { filterNewMessages, parseInboundMessage } from "./slack-inbound.js";
import { addTask, readQueue, writeQueue } from "./task-queue.js";
import type { PostFn } from "./bridge-events.js";

// ---------------------------------------------------------------------------
// Queue locking
// ---------------------------------------------------------------------------

/**
 * Run a queue mutation under an advisory file lock.
 *
 * Reads the queue, passes it to fn (which may mutate it in place), then writes
 * it back. The read-mutate-write cycle is serialized so concurrent writers do
 * not lose updates.
 *
 * @param queuePath - Absolute path to the queue JSON file.
 * @param fn - Mutation to apply; receives the live queue object.
 * @returns Whatever fn returns.
 */
export async function withQueueFileLock<T>(
  queuePath: string,
  fn: (queue: TaskQueue) => Promise<T> | T,
): Promise<T> {
  const release = await lockfile.lock(queuePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500, factor: 1.5 },
    stale: 10_000,
  });
  try {
    const result = await readQueue(queuePath);
    if (!result.ok) throw new Error(result.error);
    const queue = result.value;
    const value = await fn(queue);
    const writeResult = await writeQueue(queuePath, queue);
    if (!writeResult.ok) throw new Error(writeResult.error);
    return value;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Inbound polling
// ---------------------------------------------------------------------------

/**
 * Poll all active threads for new user messages and apply them to the queue.
 *
 * Iterates task threads in ThreadState to collect feedback messages, and the
 * team summary thread to collect add_task commands. Mutates state.lastSeenTs
 * as messages are consumed so they are not re-processed on the next poll.
 *
 * @param queuePath - Absolute path to the queue JSON file.
 * @param state - Thread state (taskThreads, teamMessageTs, lastSeenTs).
 * @param post - Function to post reply messages to Slack.
 * @param slackConfig - Bot token and channel ID for Slack API calls.
 * @param botUserId - The bot's own Slack user ID (to skip self-messages).
 */
export async function pollInbound(
  queuePath: string,
  state: ThreadState,
  post: PostFn,
  slackConfig: { botToken: string; channelId: string },
  botUserId: string,
): Promise<void> {
  for (const [taskId, threadTs] of Object.entries(state.taskThreads)) {
    const oldest = state.lastSeenTs[threadTs];
    const result = await getConversationReplies(slackConfig, threadTs, { oldest });
    if (!result.ok) {
      console.error(`Failed to fetch replies for task ${taskId}: ${result.error}`);
      continue;
    }
    const newMessages = filterNewMessages(result.value, oldest, botUserId);
    for (const msg of newMessages) {
      const action = parseInboundMessage({ source: { type: "task", taskId }, text: msg.text });
      if (action.kind === "feedback") {
        try {
          await withQueueFileLock(queuePath, (queue) => {
            const task = queue.tasks.find((t) => t.id === taskId);
            if (task !== undefined) {
              const prior = task.feedback !== undefined ? task.feedback + "\n\n" : "";
              task.feedback = prior + action.text;
              task.updatedAt = Date.now();
            }
          });
        } catch (err) {
          console.error(`Failed to append feedback for task ${taskId}: ${String(err)}`);
        }
        await post([], `💬 Feedback noted for task ${taskId}`, threadTs);
      }
      if (msg.ts > (state.lastSeenTs[threadTs] ?? "")) {
        state.lastSeenTs[threadTs] = msg.ts;
      }
    }
  }

  if (state.teamMessageTs !== null) {
    const teamTs = state.teamMessageTs;
    const oldest = state.lastSeenTs[teamTs];
    const result = await getConversationReplies(slackConfig, teamTs, { oldest });
    if (!result.ok) {
      console.error(`Failed to fetch team thread replies: ${result.error}`);
      return;
    }
    const newMessages = filterNewMessages(result.value, oldest, botUserId);
    for (const msg of newMessages) {
      const action = parseInboundMessage({ source: { type: "team" }, text: msg.text });
      if (action.kind === "add_task") {
        let newTaskId = "";
        try {
          await withQueueFileLock(queuePath, (queue) => {
            const task = addTask(queue, action.title, action.description, "slack-user");
            newTaskId = task.id;
          });
        } catch (err) {
          console.error(`Failed to add task from Slack: ${String(err)}`);
        }
        if (newTaskId !== "") {
          await post([], `📋 Task added: ${action.title} (id: ${newTaskId})`, teamTs);
        }
      }
      if (msg.ts > (state.lastSeenTs[teamTs] ?? "")) {
        state.lastSeenTs[teamTs] = msg.ts;
      }
    }
  }
}
