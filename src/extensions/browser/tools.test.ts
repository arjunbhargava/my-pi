import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerBrowserCheck, type BrowserCheckWiring } from "./tools.js";
import { BrowserManager } from "./manager.js";
import { SignalBuffer } from "./signals.js";

// Stub theme matching the structural RenderTheme the renderers accept. The
// markers make it easy to assert which theme calls produced the output.
const stubTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

type RegisteredDefinition = Parameters<BrowserCheckWiring["register"]>[0];

function registerWithStubs(): RegisteredDefinition {
  let registered: RegisteredDefinition | undefined;
  registerBrowserCheck({
    register: (definition) => {
      registered = definition;
    },
    manager: new BrowserManager(async () => {
      throw new Error("browser launch not expected in this test");
    }),
    signals: new SignalBuffer(),
    resizeImage: async () => null,
  });
  assert.ok(registered, "registerBrowserCheck should call the registrar");
  return registered;
}

describe("registerBrowserCheck", () => {
  it("registers a browser_check definition with the expected schema", () => {
    const definition = registerWithStubs();
    assert.equal(definition.name, "browser_check");
    assert.equal(definition.label, "Browser Check");
    assert.deepEqual(Object.keys(definition.parameters.properties).sort(), [
      "compareToPrevious",
      "fullPage",
      "responsive",
      "selector",
      "url",
    ]);
  });

  it("renderCall shows the url and capture mode", () => {
    const definition = registerWithStubs();
    const component = definition.renderCall(
      { url: "http://localhost:5173", responsive: true },
      stubTheme,
    );
    const rendered = component.render(120).join("\n");
    assert.match(rendered, /browser_check/);
    assert.match(rendered, /http:\/\/localhost:5173 \(responsive 390px\+1440px\)/);
  });

  it("renderResult shows the error in error color when details carry one", () => {
    const definition = registerWithStubs();
    const component = definition.renderResult(
      {
        details: {
          url: "http://localhost:5173",
          mode: "viewport",
          images: [],
          summary: "Navigation failed",
          error: "Navigation failed",
        },
      },
      { expanded: false },
      stubTheme,
    );
    // Text.render pads lines to the requested width; trim before comparing.
    assert.equal(component.render(120).join("\n").trimEnd(), "<error>Navigation failed</error>");
  });

  it("renderResult falls back to a dim placeholder without details", () => {
    const definition = registerWithStubs();
    const component = definition.renderResult({}, { expanded: false }, stubTheme);
    assert.equal(component.render(120).join("\n").trimEnd(), "<dim>no screenshot captured</dim>");
  });

  it("execute returns a structured error result when the browser cannot launch", async () => {
    const definition = registerWithStubs();
    const result = await definition.execute("call-1", { url: "http://localhost:5173" });
    assert.equal(result.isError, true);
    assert.equal(result.details.url, "http://localhost:5173");
    assert.equal(result.details.mode, "viewport");
    assert.ok(result.details.error);
  });
});
