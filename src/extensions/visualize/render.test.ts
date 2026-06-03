import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderSvgToPng } from "./render.js";

const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">' +
  '<rect width="100" height="50" fill="red"/>' +
  "</svg>";

describe("renderSvgToPng", () => {
  it("renders a valid minimal SVG to PNG", async () => {
    const result = await renderSvgToPng(VALID_SVG);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.ok(result.imageBase64.length > 0);
    assert.equal(result.widthPx, 100);
    assert.equal(result.heightPx, 50);
  });

  it("returns ok:false for an empty string", async () => {
    const result = await renderSvgToPng("");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /svg/i);
  });

  it("returns ok:false for non-SVG text", async () => {
    const result = await renderSvgToPng("hello world");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.error, /svg/i);
  });

  it("returns ok:false for malformed SVG that sharp rejects", async () => {
    const result = await renderSvgToPng("<svg><broken");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.error.length > 0);
  });
});
