/**
 * Standalone outbound bridge: watches a team queue file and posts status
 * updates to Slack with per-worker message threading.
 *
 * Usage: npx tsx scripts/team-slack-bridge.ts [--dry-run] <queue-path>
 *
 * Required env vars (skipped in dry-run mode):
 *   SLACK_BOT_TOKEN   xoxb-... bot user OAuth token
 *   SLACK_CHANNEL_ID  C0... channel to post in
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as lockfile from "proper-lockfile";

import type { TaskQueue } from "../src/lib/types.js";
import type { SlackBlock } from "../src/lib/slack.js";
import { getAuthTest, getConversationReplies, postMessage } from "../src/lib/slack.js";
import { diffQueues } from "../src/lib/queue-diff.js";
import {
  formatQueueEvent,
  formatTeamSummary,
  formatWorkerThreadHeader,
  formatCodeDiff,
} from "../src/lib/slack-format.js";
import {
  createThreadState,
  loadThreadState,
  saveThreadState,
  threadStatePath,
} from "../src/lib/slack-threads.js";
import type { ThreadState } from "../src/lib/slack-threads.js";
import {
  filterNewMessages,
  parseInboundMessage,
} from "../src/lib/slack-inbound.js";
import {
  addTask,
  readQueue,
  writeQueue,
} from "../src/lib/task-queue.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dry-run fake postMessage
// ---------------------------------------------------------------------------

let dryRunCounter = 0;

function dryRunPost(blocks: SlackBlock[], label: string): string {
  const ts = `dry-run-${++dryRunCounter}`;
  console.log(`\n[DRY-RUN] ${label} (ts=${ts})`);
  for (const block of blocks) {
    if (block.type === "header") {
      console.log(`  HEADER: ${block.text.text}`);
    } else if (block.type === "section") {
      console.log(`  SECTION: ${block.text.text.slice(0, 120)}`);
    } else if (block.type === "context") {
      console.log(`  CONTEXT: ${block.elements.map((e) => ("text" in e ? e.text : "")).join(" | ")}`);
    }
  }
  return ts;
}

// ---------------------------------------------------------------------------
// Repo-dir derivation
// ---------------------------------------------------------------------------

/**
 * Given a queue path like `/path/to/my-pi-worktrees/.team-abc.json`,
 * derive the repo root `/path/to/my-pi` by stripping the `-worktrees` suffix
 * from the parent directory name.
 */
function deriveRepoDir(queuePath: string): string {
  const worktreesDir = path.dirname(queuePath);
  const parentDir = path.dirname(worktreesDir);
  const worktreesDirName = path.basename(worktreesDir);
  const repoName = worktreesDirName.endsWith("-worktrees")
    ? worktreesDirName.slice(0, -"-worktrees".length)
    : worktreesDirName;
  return path.join(parentDir, repoName);
}

// ---------------------------------------------------------------------------
// Git diff
// ---------------------------------------------------------------------------

async function fetchGitDiff(
  repoDir: string,
  targetBranch: string,
  branchName: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "diff", `${targetBranch}...${branchName}`],
      { timeout: 10_000 },
    );
    return stdout;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Queue reading
// ---------------------------------------------------------------------------

async function readQueueFile(queuePath: string): Promise<TaskQueue | null> {
  try {
    const raw = await readFile(queuePath, "utf-8");
    return JSON.parse(raw) as TaskQueue;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Queue locking
// ---------------------------------------------------------------------------

/** Run a queue mutation under an advisory file lock (load-mutate-save is atomic). */
async function withQueueFileLock<T>(
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

/** Poll all active threads for new user messages and apply them to the queue. */
async function pollInbound(
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
        let taskId = "";
        try {
          await withQueueFileLock(queuePath, (queue) => {
            const task = addTask(queue, action.title, action.description, "slack-user");
            taskId = task.id;
          });
        } catch (err) {
          console.error(`Failed to add task from Slack: ${String(err)}`);
        }
        if (taskId !== "") {
          await post([], `📋 Task added: ${action.title} (id: ${taskId})`, teamTs);
        }
      }
      if (msg.ts > (state.lastSeenTs[teamTs] ?? "")) {
        state.lastSeenTs[teamTs] = msg.ts;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

type PostFn = (
  blocks: SlackBlock[],
  text: string,
  threadTs?: string,
) => Promise<string | null>;

async function processEvents(
  queue: TaskQueue,
  previousQueue: TaskQueue,
  state: ThreadState,
  post: PostFn,
  repoDir: string,
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
      if (task?.branchName !== undefined && task?.branchName.length > 0) {
        const diffOutput = await fetchGitDiff(repoDir, queue.targetBranch, task.branchName);
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const queuePath = args.find((a) => !a.startsWith("--"));

  const pollIntervalIdx = args.indexOf("--poll-interval");
  const pollIntervalSecs =
    pollIntervalIdx !== -1 && args[pollIntervalIdx + 1] !== undefined
      ? parseInt(args[pollIntervalIdx + 1], 10)
      : 10;

  if (queuePath === undefined) {
    console.error("Usage: npx tsx scripts/team-slack-bridge.ts [--dry-run] [--poll-interval <secs>] <queue-path>");
    process.exit(1);
  }

  let botToken = "";
  let channelId = "";

  if (!isDryRun) {
    botToken = process.env["SLACK_BOT_TOKEN"] ?? "";
    channelId = process.env["SLACK_CHANNEL_ID"] ?? "";
    if (!botToken || !channelId) {
      console.error("Missing required env vars: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID");
      console.error("Pass --dry-run to print formatted output without Slack credentials.");
      process.exit(1);
    }
  }

  const initialQueue = await readQueueFile(queuePath);
  if (initialQueue === null) {
    console.error(`Cannot read queue file: ${queuePath}`);
    process.exit(1);
  }

  const sidecarPath = threadStatePath(queuePath);
  const loadResult = await loadThreadState(sidecarPath);
  let state: ThreadState = loadResult.ok
    ? loadResult.value
    : createThreadState(
        initialQueue.teamId,
        isDryRun ? "dry-run" : channelId,
      );

  const slackConfig = { botToken, channelId };
  const repoDir = deriveRepoDir(queuePath);

  const post: PostFn = async (blocks, text, threadTs) => {
    if (isDryRun) {
      return dryRunPost(blocks, threadTs !== undefined ? `reply in ${threadTs}` : "top-level");
    }
    const result = await postMessage(slackConfig, { text, blocks, threadTs });
    if (!result.ok) {
      console.error(`Slack error: ${result.error}`);
      return null;
    }
    return result.value.ts;
  };

  if (state.teamMessageTs === null) {
    const summaryBlocks = formatTeamSummary(initialQueue);
    const ts = await post(summaryBlocks, `Team: ${initialQueue.goal}`);
    if (ts !== null) {
      state.teamMessageTs = ts;
      await saveThreadState(sidecarPath, state);
    }
  }

  console.log(
    `Bridge started for team ${initialQueue.teamId}, posting to ${isDryRun ? "dry-run" : channelId}`,
  );

  let botUserId = "";
  if (isDryRun) {
    console.log("Inbound polling disabled in dry-run mode.");
  } else {
    botUserId = process.env["SLACK_BOT_USER_ID"] ?? "";
    if (!botUserId) {
      const authResult = await getAuthTest(botToken);
      if (authResult.ok) {
        botUserId = authResult.value.userId;
      } else {
        console.error(`Failed to resolve bot user ID via auth.test: ${authResult.error}`);
        console.error("Set SLACK_BOT_USER_ID to skip the auth.test call.");
      }
    }

    const pollMs = pollIntervalSecs * 1000;
    const pollTimer = setInterval(() => {
      void pollInbound(queuePath, state, post, slackConfig, botUserId).then(async () => {
        await saveThreadState(sidecarPath, state);
      });
    }, pollMs);
    pollTimer.unref();
  }

  let previousQueue: TaskQueue = initialQueue;
  let pending = false;

  const handleChange = (): void => {
    if (pending) return;
    pending = true;
    setImmediate(async () => {
      pending = false;
      const queue = await readQueueFile(queuePath);
      if (queue === null) return;
      await processEvents(queue, previousQueue, state, post, repoDir);
      await saveThreadState(sidecarPath, state);
      previousQueue = queue;
    });
  };

  const dir = path.dirname(queuePath);
  const base = path.basename(queuePath);
  const watcher = watch(dir, { persistent: true }, (_event, name) => {
    if (name === base) handleChange();
  });

  const shutdown = async (): Promise<void> => {
    watcher.close();
    await saveThreadState(sidecarPath, state);
    console.log("Bridge stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
