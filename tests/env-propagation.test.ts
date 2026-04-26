/**
 * Unit tests for env-propagation.ts.
 *
 * Covers prefix matching, suffix matching, case insensitivity, empty-value
 * filtering, non-matching exclusion, and prefix-anchor correctness.
 *
 * Run: npx tsx tests/env-propagation.test.ts
 */

import { strict as assert } from "node:assert";

import { collectPropagatedEnvVars } from "../src/extensions/agents/env-propagation.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

test("prefix match: TAVILY_ prefix is included", () => {
  process.env["TAVILY_API_KEY"] = "tvly-secret";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["TAVILY_API_KEY"], "tvly-secret");
  } finally {
    delete process.env["TAVILY_API_KEY"];
  }
});

test("prefix match: ANTHROPIC_ prefix is included", () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-secret";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["ANTHROPIC_API_KEY"], "sk-ant-secret");
  } finally {
    delete process.env["ANTHROPIC_API_KEY"];
  }
});

test("prefix match: AWS_ prefix is included", () => {
  process.env["AWS_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["AWS_ACCESS_KEY_ID"], "AKIAIOSFODNN7EXAMPLE");
  } finally {
    delete process.env["AWS_ACCESS_KEY_ID"];
  }
});

test("suffix match: _API_KEY suffix is included", () => {
  process.env["MY_CUSTOM_API_KEY"] = "custom-secret";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["MY_CUSTOM_API_KEY"], "custom-secret");
  } finally {
    delete process.env["MY_CUSTOM_API_KEY"];
  }
});

test("suffix match: _BEARER_TOKEN suffix is included", () => {
  process.env["SOME_BEARER_TOKEN"] = "bearer-value";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["SOME_BEARER_TOKEN"], "bearer-value");
  } finally {
    delete process.env["SOME_BEARER_TOKEN"];
  }
});

test("case insensitive: lowercase var name matches prefix", () => {
  process.env["tavily_api_key"] = "tvly-lower";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["tavily_api_key"], "tvly-lower");
  } finally {
    delete process.env["tavily_api_key"];
  }
});

test("case insensitive: mixed-case var name matches suffix", () => {
  process.env["My_Custom_Api_Key"] = "mixed-secret";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["My_Custom_Api_Key"], "mixed-secret");
  } finally {
    delete process.env["My_Custom_Api_Key"];
  }
});

test("empty value: matching var with empty string is excluded", () => {
  process.env["TAVILY_API_KEY"] = "";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(Object.prototype.hasOwnProperty.call(vars, "TAVILY_API_KEY"), false);
  } finally {
    delete process.env["TAVILY_API_KEY"];
  }
});

test("non-matching: PATH is excluded", () => {
  const vars = collectPropagatedEnvVars();
  assert.equal(Object.prototype.hasOwnProperty.call(vars, "PATH"), false);
});

test("non-matching: HOME is excluded", () => {
  const saved = process.env["HOME"];
  process.env["HOME"] = "/home/user";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(Object.prototype.hasOwnProperty.call(vars, "HOME"), false);
  } finally {
    if (saved !== undefined) {
      process.env["HOME"] = saved;
    } else {
      delete process.env["HOME"];
    }
  }
});

test("non-matching: EDITOR is excluded", () => {
  process.env["EDITOR"] = "vim";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(Object.prototype.hasOwnProperty.call(vars, "EDITOR"), false);
  } finally {
    delete process.env["EDITOR"];
  }
});

test("prefix anchoring: NOTAVILY_KEY does not match TAVILY prefix", () => {
  process.env["NOTAVILY_KEY"] = "should-not-propagate";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(Object.prototype.hasOwnProperty.call(vars, "NOTAVILY_KEY"), false);
  } finally {
    delete process.env["NOTAVILY_KEY"];
  }
});

test("BROWSERBASE prefix is propagated", () => {
  process.env["BROWSERBASE_API_KEY"] = "bb-test";
  process.env["BROWSERBASE_PROJECT_ID"] = "proj-123";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(vars["BROWSERBASE_API_KEY"], "bb-test");
    assert.equal(vars["BROWSERBASE_PROJECT_ID"], "proj-123");
  } finally {
    delete process.env["BROWSERBASE_API_KEY"];
    delete process.env["BROWSERBASE_PROJECT_ID"];
  }
});

test("prefix anchoring: XOPENAI_TOKEN does not match OPENAI prefix", () => {
  process.env["XOPENAI_TOKEN"] = "should-not-propagate";
  try {
    const vars = collectPropagatedEnvVars();
    assert.equal(Object.prototype.hasOwnProperty.call(vars, "XOPENAI_TOKEN"), false);
  } finally {
    delete process.env["XOPENAI_TOKEN"];
  }
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
      console.log(`    ${err instanceof Error ? err.stack : String(err)}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

console.log("env-propagation tests:\n");
run();
