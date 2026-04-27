/**
 * Core event routing for the Slack outbound bridge.
 *
 * Translates queue diff events into Slack messages, deciding which thread
 * each event belongs in and mutating ThreadState accordingly. Extracted as a
 * lib module so it can be unit-tested without the bridge script's heavy
 * dependencies (file watchers, lock files, etc.).
 */

import type { SlackBlock } from "./slack.js";
import type { TaskQueue } from "./types.js";
import type { ThreadState } from "./slack-threads.js";
import { diffQueues } from "./queue-diff.js";
import {
  formatQueueEvent,
  formatWorkerThreadHeader,
  formatCodeDiff,
} from "./slack-format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function that posts a Slack message and returns its timestamp, or null on error. */
export type PostFn = (
  blocks: SlackBlock[],
  text: string,
  threadTs?: string,
) => Promise<string | null>;

/** Function that fetches a git diff between two branches. */
export type DiffFn = (
  repoDir: string,
  targetBranch: string,
  branchName: string,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

/**
 * Process all queue transitions between two snapshots and post them to Slack.
 *
 * Routing rules:
 * - task_dispatched → top-level message with worker thread header; ts stored in state.taskThreads
 * - task_completed → thread reply with event + diff blocks; ts stored in state.lastPostedTs
 * - task_closed/rejected/recovered → thread reply in the worker's thread
 * - task_added → thread reply in the team summary thread
 *
 * @param queue - Current queue snapshot.
 * @param previousQueue - Previous queue snapshot to diff against.
 * @param state - Thread state to read from and mutate.
 * @param post - Function that posts a message and returns its Slack ts.
 * @param repoDir - Absolute path to the git repo root (for diff fetching).
 * @param diffFn - Function that fetches a git diff between two refs.
 */
export async function processEvents(
  queue: TaskQueue,
  previousQueue: TaskQueue,
  state: ThreadState,
  post: PostFn,
  repoDir: string,
  diffFn: DiffFn,
): Promise<void> {
  const events = diffQueues(previousQueue, queue);

  for (const event of events) {
    const blocks = formatQueueEvent(event);

    if (event.type === "task_dispatched") {
      const task = event.task;
      if (task === undefined) continue;
      const headerBlocks = formatWorkerThreadHeader(task);
      const ts = await post(headerBlocks, event.title);
      if (ts !== null) {
        state.taskThreads[event.taskId] = ts;
      }
      continue;
    }

    if (event.type === "task_completed") {
      const task = event.task;
      const threadTs = state.taskThreads[event.taskId];
      let diffBlocks: SlackBlock[] = [];
      if (task?.branchName !== undefined && task.branchName.length > 0) {
        const diffOutput = await diffFn(repoDir, queue.targetBranch, task.branchName);
        diffBlocks = formatCodeDiff(diffOutput);
      }
      await post([...blocks, ...diffBlocks], event.title, threadTs);
      if (threadTs !== undefined) {
        state.lastPostedTs[event.taskId] = threadTs;
      }
      continue;
    }

    if (
      event.type === "task_closed" ||
      event.type === "task_rejected" ||
      event.type === "task_recovered"
    ) {
      const threadTs = state.taskThreads[event.taskId];
      await post(blocks, event.title, threadTs);
      continue;
    }

    if (event.type === "task_added") {
      const teamTs = state.teamMessageTs ?? undefined;
      await post(blocks, event.title, teamTs);
      continue;
    }
  }
}
