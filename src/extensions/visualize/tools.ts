/**
 * Tool and command registration stubs for the visualize extension.
 *
 * These are stubs to be implemented in a later task. The signatures
 * match what visualize.ts expects so the extension entry point compiles.
 *
 * Do NOT import from `@earendil-works/pi-coding-agent` here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's ExtensionAPI type; imported only in the entry point
type PiAPI = any;

/**
 * Register the `visualize` tool with pi.
 *
 * @param pi - The pi ExtensionAPI instance.
 * @stub Rendering logic is implemented in a later task.
 */
export function registerVisualizeTools(_pi: PiAPI): void {}

/**
 * Register the `/visualize` slash command with pi.
 *
 * @param pi - The pi ExtensionAPI instance.
 * @stub Command implementation lands in a later task.
 */
export function registerVisualizeCommand(_pi: PiAPI): void {}
