/**
 * Unit tests for agent config parsing and discovery.
 *
 * Run: npx tsx tests/agent-config.test.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

import { discoverAgents, parseAgentFile } from "../src/extensions/agents/agent-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function setup(): Promise<string> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "agent-config-test-"));
  return tmpDir;
}

async function cleanup(): Promise<void> {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
}

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("parseAgentFile parses valid frontmatter", async () => {
  const dir = await setup();
  const filePath = path.join(dir, "scout.md");
  await writeFile(filePath, [
    "---",
    "name: scout",
    "description: Fast recon",
    "model: claude-haiku-4-5",
    "tools: read, grep, find, ls",
    "---",
    "",
    "You are a scout. Find things fast.",
  ].join("\n"));

  const result = await parseAgentFile(filePath, "worker");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.name, "scout");
  assert.equal(result.value.description, "Fast recon");
  assert.equal(result.value.model, "claude-haiku-4-5");
  assert.deepEqual(result.value.tools, ["read", "grep", "find", "ls"]);
  assert.equal(result.value.role, "worker");
  assert.ok(result.value.systemPrompt.includes("scout"));
  await cleanup();
});

test("parseAgentFile fails on missing name", async () => {
  const dir = await setup();
  const filePath = path.join(dir, "bad.md");
  await writeFile(filePath, "---\ndescription: No name\n---\nPrompt.");

  const result = await parseAgentFile(filePath, "worker");
  assert.ok(!result.ok);
  assert.ok(result.error.includes("Missing 'name'"));
  await cleanup();
});

test("parseAgentFile fails on missing frontmatter", async () => {
  const dir = await setup();
  const filePath = path.join(dir, "plain.md");
  await writeFile(filePath, "Just some text without frontmatter.");

  const result = await parseAgentFile(filePath, "worker");
  assert.ok(!result.ok);
  assert.ok(result.error.includes("No YAML frontmatter"));
  await cleanup();
});

test("parseAgentFile handles optional fields", async () => {
  const dir = await setup();
  const filePath = path.join(dir, "minimal.md");
  await writeFile(filePath, "---\nname: minimal\n---\nDo things.");

  const result = await parseAgentFile(filePath, "permanent");
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.equal(result.value.name, "minimal");
  assert.equal(result.value.model, undefined);
  assert.equal(result.value.tools, undefined);
  assert.equal(result.value.role, "permanent");
  await cleanup();
});

test("discoverAgents finds roles and workers", async () => {
  const dir = await setup();
  const rolesDir = path.join(dir, "roles");
  const workersDir = path.join(dir, "workers");
  await mkdir(rolesDir, { recursive: true });
  await mkdir(workersDir, { recursive: true });

  await writeFile(path.join(rolesDir, "orch.md"), "---\nname: orchestrator\n---\nPlan.");
  await writeFile(path.join(workersDir, "impl.md"), "---\nname: implementer\n---\nBuild.");
  await writeFile(path.join(workersDir, "scout.md"), "---\nname: scout\n---\nFind.");

  const { agents, errors } = await discoverAgents(dir);
  assert.equal(errors.length, 0);
  assert.equal(agents.length, 3);

  const orch = agents.find((a) => a.name === "orchestrator");
  assert.ok(orch);
  assert.equal(orch!.role, "permanent");

  const impl = agents.find((a) => a.name === "implementer");
  assert.ok(impl);
  assert.equal(impl!.role, "worker");
  await cleanup();
});

test("discoverAgents handles missing directories gracefully", async () => {
  const { agents, errors } = await discoverAgents("/nonexistent/agents");
  assert.equal(agents.length, 0);
  assert.equal(errors.length, 0);
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

console.log("agent-config tests:\n");
run();
