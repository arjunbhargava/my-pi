/**
 * Tests for src/lib/calculator.ts
 *
 * Run: npx tsx tests/calculator.test.ts
 */

import { strict as assert } from "node:assert";
import { add, subtract, multiply, divide } from "../src/lib/calculator.js";

assert.equal(add(2, 3), 5);
assert.equal(subtract(10, 4), 6);
assert.equal(multiply(3, 7), 21);

const divOk = divide(10, 2);
assert.deepEqual(divOk, { ok: true, value: 5 });

const divZero = divide(1, 0);
assert.deepEqual(divZero, { ok: false, error: "division by zero" });

console.log("All calculator tests passed.");
