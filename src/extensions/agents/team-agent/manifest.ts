/**
 * Role-based tool manifest.
 *
 * Determines which tools each agent role receives. This is the single
 * source of truth for tool-to-role mapping — no tool registration
 * happens outside what the manifest declares.
 *
 * Design principle: each role has exactly one blocking "wait" tool
 * matched to its lifecycle, and no tool appears in two roles where it
 * could cause behavioral confusion.
 *
 *   Orchestrator: monitor_tasks (any queue state change)
 *   Evaluator:    wait_to_evaluate (task enters review, auto-rebased)
 *   Workers:      wait_for_verdict (task leaves review after complete)
 */

import type { TeamAgentConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/**
 * Flags controlling which tool bundles to register for an agent.
 * Each flag maps to one or more tool registrations in the entry point.
 */
export interface ToolManifest {
  /** read_queue — inspect queue state */
  readQueue: boolean;
  /** add_task — append new tasks to the queue */
  addTask: boolean;
  /** complete_task — worker marks task as done */
  completeTask: boolean;
  /** wait_for_verdict — worker blocks until evaluator acts on its task */
  waitForVerdict: boolean;
  /** dispatch_task, monitor_tasks, check_workers — orchestrator controls */
  dispatch: boolean;
  /** wait_to_evaluate, close_task, revise_task, reject_task — evaluator controls */
  review: boolean;
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

/**
 * Derive the tool manifest from the agent's configuration.
 *
 * The mapping is:
 *   orchestrator → read_queue, add_task, dispatch bundle
 *   evaluator    → read_queue, review bundle
 *   worker       → read_queue, complete_task, wait_for_verdict
 */
export function getToolManifest(config: TeamAgentConfig): ToolManifest {
  // Base: nothing enabled
  const manifest: ToolManifest = {
    readQueue: false,
    addTask: false,
    completeTask: false,
    waitForVerdict: false,
    dispatch: false,
    review: false,
  };

  if (config.role === "worker") {
    manifest.readQueue = true;
    manifest.completeTask = true;
    manifest.waitForVerdict = true;
    return manifest;
  }

  // Permanent roles — distinguished by capabilities
  manifest.readQueue = true;

  if (config.capabilities.includes("dispatch")) {
    // Orchestrator
    manifest.addTask = true;
    manifest.dispatch = true;
  } else if (config.capabilities.includes("close")) {
    // Evaluator
    manifest.addTask = true;
    manifest.review = true;
  }

  return manifest;
}
