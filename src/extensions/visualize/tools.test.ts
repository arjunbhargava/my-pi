import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerVisualize } from "./tools.js";

const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<rect width="200" height="100" fill="blue"/>' +
  "</svg>";

/** Minimal pi stub that records registerTool / registerCommand calls. */
function makeFakePi() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commands: Record<string, any> = {};
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool(def: any) { tools[def.name] = def; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCommand(name: string, def: any) { commands[name] = def; },
    tools,
    commands,
  };
}

describe("registerVisualize", () => {
  it("registers exactly one tool named 'visualize'", () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    assert.ok("visualize" in pi.tools, "tool 'visualize' not registered");
    assert.equal(Object.keys(pi.tools).length, 1);
  });

  it("registers a command named 'visualize'", () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    assert.ok("visualize" in pi.commands, "command 'visualize' not registered");
  });

  it("tool parameters schema includes kind, content, and optional title", () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const { parameters } = pi.tools["visualize"];
    assert.equal(parameters.type, "object");
    assert.ok("kind" in parameters.properties, "parameters.kind missing");
    assert.ok("content" in parameters.properties, "parameters.content missing");
    assert.ok("title" in parameters.properties, "parameters.title missing");
  });

  it("execute returns imageBase64 and dimension fields for valid SVG", async () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const tool = pi.tools["visualize"];
    const result = await tool.execute("id", { kind: "svg", content: VALID_SVG, title: "Test chart" });
    const details = result.details as {
      imageBase64?: string;
      widthPx?: number;
      heightPx?: number;
    };
    assert.ok(typeof details.imageBase64 === "string" && details.imageBase64.length > 0,
      "imageBase64 should be a non-empty string");
    assert.equal(typeof details.widthPx, "number");
    assert.equal(typeof details.heightPx, "number");
  });

  it("execute throws for non-SVG content", async () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const tool = pi.tools["visualize"];
    await assert.rejects(
      () => tool.execute("id", { kind: "svg", content: "not svg at all" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
