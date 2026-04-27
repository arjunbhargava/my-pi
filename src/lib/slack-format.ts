/**
 * Pure formatting module that converts queue events and queue state into
 * Slack Block Kit messages. No I/O, no side effects.
 */

import type {
  SlackBlock,
  SectionBlock,
  HeaderBlock,
  ContextBlock,
} from "./slack.js";
import type { QueueEvent } from "./queue-diff.js";
import type { Task, TaskQueue } from "./types.js";

const DEFAULT_MAX_DIFF_CHARS = 2900;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "...";
}

function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function header(text: string): HeaderBlock {
  return { type: "header", text: { type: "plain_text", text } };
}

function context(text: string): ContextBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/**
 * Converts a single QueueEvent into Slack blocks.
 *
 * Format per event type:
 * - task_added: section with queued title + context with description preview
 * - task_dispatched: section with assignee and attempt number
 * - task_completed: section with review title + context with result preview
 * - task_closed: section with title and attempt count
 * - task_rejected: section with rejection title + context with feedback preview
 * - task_recovered: section with requeue notice
 *
 * @param event - The queue event to format.
 * @returns Array of Slack Block Kit blocks.
 */
export function formatQueueEvent(event: QueueEvent): SlackBlock[] {
  switch (event.type) {
    case "task_added": {
      const blocks: SlackBlock[] = [section(`📋 *Queued:* ${event.title}`)];
      const desc = event.task?.description;
      if (desc) blocks.push(context(truncate(desc, 200)));
      return blocks;
    }

    case "task_dispatched": {
      const assignedTo = event.task?.assignedTo ?? "unknown";
      const attempts = event.task?.attempts ?? 1;
      return [
        section(
          `⚡ *Dispatched:* ${event.title} → \`${assignedTo}\` (attempt ${attempts})`,
        ),
      ];
    }

    case "task_completed": {
      const blocks: SlackBlock[] = [
        section(`✅ *Ready for review:* ${event.title}`),
      ];
      const result = event.task?.result;
      if (result) blocks.push(context(truncate(result, 200)));
      return blocks;
    }

    case "task_closed": {
      const attempts = event.closedTask?.attempts ?? 1;
      return [section(`🎉 *Merged:* ${event.title} (${attempts} attempt(s))`)];
    }

    case "task_rejected": {
      const blocks: SlackBlock[] = [section(`🔄 *Rejected:* ${event.title}`)];
      const feedback = event.task?.feedback;
      if (feedback) blocks.push(context(truncate(feedback, 200)));
      return blocks;
    }

    case "task_recovered":
      return [section(`⚠️ *Worker died:* ${event.title} — requeued`)];
  }
}

/**
 * Produces a summary message for the initial team Slack post.
 *
 * Includes a header with the team goal, status counts for all tasks,
 * and a list of currently queued task titles when any exist.
 *
 * @param queue - The full task queue to summarize.
 * @returns Array of Slack Block Kit blocks.
 */
export function formatTeamSummary(queue: TaskQueue): SlackBlock[] {
  const queued = queue.tasks.filter((t) => t.status === "queued");
  const active = queue.tasks.filter((t) => t.status === "active");
  const review = queue.tasks.filter((t) => t.status === "review");

  const blocks: SlackBlock[] = [
    header(`🏁 Team: ${queue.goal}`),
    section(
      `${queued.length} queued, ${active.length} active, ${review.length} in review, ${queue.closed.length} closed`,
    ),
  ];

  if (queued.length > 0) {
    blocks.push(section(queued.map((t) => `• ${t.title}`).join("\n")));
  }

  return blocks;
}

/**
 * Wraps a git diff string in a Slack code block.
 *
 * Truncates the diff if it exceeds maxChars (default 2900) and appends a
 * note with the total character count. Returns a "_No changes_" block for
 * empty input.
 *
 * @param diff - Raw git diff string.
 * @param maxChars - Maximum characters for the diff body before truncation.
 * @returns Array containing a single Slack section block.
 */
export function formatCodeDiff(
  diff: string,
  maxChars = DEFAULT_MAX_DIFF_CHARS,
): SlackBlock[] {
  if (diff.length === 0) {
    return [section("_No changes_")];
  }

  const body =
    diff.length > maxChars
      ? diff.slice(0, maxChars) +
        `\n... (truncated, ${diff.length} chars total)`
      : diff;

  return [section("```\n" + body + "\n```")];
}

/**
 * Produces the top-level message blocks for a new worker thread.
 *
 * Includes a header with the task title, the description preview (first 500
 * chars), and a context line with task ID, assigned worker, and attempt count.
 *
 * @param task - The task being started by the worker.
 * @returns Array of Slack Block Kit blocks.
 */
export function formatWorkerThreadHeader(task: Task): SlackBlock[] {
  return [
    header(`🔧 ${task.title}`),
    section(truncate(task.description, 500)),
    context(
      `Task ID: ${task.id} | Worker: ${task.assignedTo ?? "unassigned"} | Attempt: ${task.attempts}`,
    ),
  ];
}
