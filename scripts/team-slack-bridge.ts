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
import { fileURLToPath } from "node:url";
import type { TaskQueue } from "../src/lib/types.js";
import type { SlackBlock } from "../src/lib/slack.js";
import { getAuthTest, postMessage } from "../src/lib/slack.js";
import { formatTeamSummary } from "../src/lib/slack-format.js";
import {
  createThreadState,
  loadThreadState,
  saveThreadState,
  threadStatePath,
  type ThreadState,
} from "../src/lib/slack-threads.js";
import { processEvents, type PostFn } from "../src/lib/bridge-events.js";
import { pollInbound } from "../src/lib/bridge-inbound.js";

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
      await processEvents(queue, previousQueue, state, post, repoDir, fetchGitDiff);
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

const isDirectRun = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
