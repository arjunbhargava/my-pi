/**
 * Smoke test: queue operations in an isolated context.
 *
 * Expects QUEUE_PATH environment variable pointing to the output file.
 * Run: QUEUE_PATH=/tmp/test.json npx tsx tests/smoke-queue-ops.ts
 */

import {
  addTask,
  closeTask,
  completeTask,
  createQueue,
  dispatchTask,
  getQueueSummary,
  readQueue,
  rejectTask,
  writeQueue,
} from "../src/lib/task-queue.js";

const queuePath = process.env.QUEUE_PATH;
if (!queuePath) {
  console.error("QUEUE_PATH env var required");
  process.exit(1);
}

async function main(): Promise<void> {
  // Create and write
  const q = createQueue("smoke", "Smoke test", "main", "pi-team-smoke");
  const t1 = addTask(q, "Find files", "Use find to locate ts files", "orchestrator");
  addTask(q, "Implement feature", "Add a new function", "orchestrator");

  let r = await writeQueue(queuePath, q);
  if (!r.ok) throw new Error(r.error);

  // Read back
  r = await readQueue(queuePath);
  if (!r.ok) throw new Error(r.error);
  const q2 = r.value;
  if (q2.tasks.length !== 2) throw new Error("Expected 2 tasks");

  // Dispatch → complete → reject → requeue at top
  dispatchTask(q2, t1.id, "worker-1", "orchestrator");
  completeTask(q2, t1.id, "Found 3 ts files", "worker-1");
  rejectTask(q2, t1.id, "Need file paths, not just count", "evaluator");

  if (q2.tasks[0].id !== t1.id) throw new Error("Rejected task should be at top");
  if (q2.tasks[0].feedback !== "Need file paths, not just count") throw new Error("Feedback not preserved");
  if (q2.tasks[0].result !== "Found 3 ts files") throw new Error("Previous result not preserved");

  // Dispatch again, complete, close
  dispatchTask(q2, t1.id, "worker-2", "orchestrator");
  completeTask(q2, t1.id, "Found: src/app.ts", "worker-2");
  const closed = closeTask(q2, t1.id, "evaluator");
  if (!closed.ok) throw new Error(closed.error);

  if (q2.tasks.length !== 1) throw new Error("Expected 1 remaining task");
  if (q2.closed.length !== 1) throw new Error("Expected 1 closed task");
  if (q2.closed[0].attempts !== 2) throw new Error("Expected 2 attempts");

  r = await writeQueue(queuePath, q2);
  if (!r.ok) throw new Error(r.error);

  console.log("  ✓ Queue operations: create, add, dispatch, complete, reject, close");
  console.log("  ✓ Rejection requeues at top with feedback and previous result");
  console.log("  ✓ Close archives to minimal summary");

  const summary = getQueueSummary(q2);
  if (!summary.includes("Smoke test")) throw new Error("Summary missing goal");
  console.log("  ✓ Queue summary readable");
}

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
