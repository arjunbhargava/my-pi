import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
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

  it("kind schema enum contains both 'svg' and 'image'", () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const kindSchema = pi.tools["visualize"].parameters.properties.kind as {
      type: string;
      enum: string[];
    };
    assert.equal(kindSchema.type, "string");
    assert.ok(Array.isArray(kindSchema.enum), "kind.enum should be an array");
    assert.ok(kindSchema.enum.includes("svg"), "enum should include 'svg'");
    assert.ok(kindSchema.enum.includes("image"), "enum should include 'image'");
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

  it("execute returns isError for non-SVG content", async () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const tool = pi.tools["visualize"];
    const result = await tool.execute("id", { kind: "svg", content: "not svg at all" });
    assert.equal(result.isError, true);
    assert.ok(
      typeof result.details.error === "string" && result.details.error.length > 0,
      "details.error should be a non-empty string",
    );
  });

  it("execute kind:image returns isError for a nonexistent file path", async () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const tool = pi.tools["visualize"];
    const result = await tool.execute("id", { kind: "image", content: "/nonexistent/does-not-exist.png" });
    assert.equal(result.isError, true);
    assert.ok(
      typeof result.details.error === "string" && result.details.error.length > 0,
      "details.error should be a non-empty string",
    );
  });

  it("execute kind:image returns imageBase64 and dimensions for a valid PNG data-URI", async () => {
    const pi = makeFakePi();
    registerVisualize(pi);
    const tool = pi.tools["visualize"];

    // Generate a small PNG with sharp at test time.
    const pngBuffer = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const dataUri = `data:image/png;base64,${pngBuffer.toString("base64")}`;

    const result = await tool.execute("id", { kind: "image", content: dataUri, title: "Test image" });
    assert.ok(!result.isError, `execute should not return isError; got: ${result.details?.error}`);
    const details = result.details as {
      imageBase64?: string;
      widthPx?: number;
      heightPx?: number;
    };
    assert.ok(
      typeof details.imageBase64 === "string" && details.imageBase64.length > 0,
      "imageBase64 should be a non-empty string",
    );
    assert.equal(typeof details.widthPx, "number");
    assert.equal(typeof details.heightPx, "number");
  });
});
