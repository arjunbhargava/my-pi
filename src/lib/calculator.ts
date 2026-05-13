/**
 * Basic arithmetic operations.
 */

/** Returns the sum of a and b. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Returns the difference of a minus b. */
export function subtract(a: number, b: number): number {
  return a - b;
}

/** Returns the product of a and b. */
export function multiply(a: number, b: number): number {
  return a * b;
}

/** Divides a by b. Returns an error result when b is zero. */
export function divide(
  a: number,
  b: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (b === 0) {
    return { ok: false, error: "division by zero" };
  }
  return { ok: true, value: a / b };
}
