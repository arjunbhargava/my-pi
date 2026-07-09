import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCheckContent,
  formatSignalsText,
  prepareCheckImage,
  summarizeSignalCounts,
  type CheckImage,
  type ResizeImageFn,
} from "./result.js";
import type { PageSignals } from "./signals.js";
import type { CapturedImage } from "./capture.js";

const EMPTY_SIGNALS: PageSignals = { console: [], failedRequests: [], exceptions: [] };

const MIXED_SIGNALS: PageSignals = {
  console: [
    { type: "error", text: "Cannot read properties of undefined (reading 'map')" },
    { type: "error", text: "Failed to load resource" },
    { type: "warning", text: "React key prop missing" },
  ],
  failedRequests: [
    { url: "http://localhost:5173/api/items", status: 404 },
    { url: "http://localhost:5173/ws", failureText: "net::ERR_CONNECTION_REFUSED" },
  ],
  exceptions: [{ message: "boom", stack: "Error: boom\n    at App.tsx:12" }],
};

function checkImage(label: string, data: string): CheckImage {
  return { label, data, mimeType: "image/png", widthPx: 1440, heightPx: 900 };
}

describe("formatSignalsText", () => {
  it("reports counts and full content for every signal category", () => {
    const text = formatSignalsText(MIXED_SIGNALS);

    assert.match(text, /2 console errors/);
    assert.match(text, /1 console warning/);
    assert.match(text, /2 failed requests/);
    assert.match(text, /1 uncaught exception/);

    assert.match(text, /Cannot read properties of undefined \(reading 'map'\)/);
    assert.match(text, /Failed to load resource/);
    assert.match(text, /React key prop missing/);
    assert.match(text, /http:\/\/localhost:5173\/api\/items \(HTTP 404\)/);
    assert.match(text, /http:\/\/localhost:5173\/ws \(net::ERR_CONNECTION_REFUSED\)/);
    assert.match(text, /boom/);
    assert.match(text, /at App\.tsx:12/);
  });

  it("puts errors and counts before the exception stacks", () => {
    const text = formatSignalsText(MIXED_SIGNALS);
    assert.ok(text.indexOf("Since last check:") < text.indexOf("Console errors:"));
    assert.ok(text.indexOf("Console errors:") < text.indexOf("Uncaught exceptions:"));
  });

  it("says nothing happened when the buffer was empty", () => {
    assert.equal(
      formatSignalsText(EMPTY_SIGNALS),
      "No console errors, warnings, failed requests, or exceptions since last check.",
    );
  });
});

describe("summarizeSignalCounts", () => {
  it("returns null for empty signals", () => {
    assert.equal(summarizeSignalCounts(EMPTY_SIGNALS), null);
  });

  it("lists only non-zero categories", () => {
    const summary = summarizeSignalCounts({
      console: [{ type: "error", text: "x" }],
      failedRequests: [],
      exceptions: [],
    });
    assert.equal(summary, "1 console error");
  });
});

describe("prepareCheckImage", () => {
  const inBoundsImage: CapturedImage = { label: "viewport", base64: "AAAA", widthPx: 1440, heightPx: 900 };
  const overWideImage: CapturedImage = {
    label: "fullPage",
    base64: "BBBB",
    widthPx: 3000,
    heightPx: 2000,
    downscaleToWidthPx: 1500,
  };

  it("does not call resize when the image is within bounds", async () => {
    const neverResize: ResizeImageFn = async () => {
      throw new Error("resize must not be called");
    };

    const result = await prepareCheckImage(inBoundsImage, neverResize);
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      label: "viewport",
      data: "AAAA",
      mimeType: "image/png",
      widthPx: 1440,
      heightPx: 900,
    });
  });

  it("resizes over-wide images to the marked width and uses the resized output", async () => {
    const resizeCalls: Array<{ maxWidth?: number }> = [];
    const resize: ResizeImageFn = async (_bytes, _mimeType, options) => {
      resizeCalls.push({ maxWidth: options?.maxWidth });
      return { data: "RESIZED", mimeType: "image/jpeg", width: 1500, height: 1000 };
    };

    const result = await prepareCheckImage(overWideImage, resize);
    assert.ok(result.ok);
    assert.deepEqual(resizeCalls, [{ maxWidth: 1500 }]);
    assert.deepEqual(result.value, {
      label: "fullPage",
      data: "RESIZED",
      mimeType: "image/jpeg",
      widthPx: 1500,
      heightPx: 1000,
    });
  });

  it("returns an error instead of an over-wide image when resize yields null", async () => {
    const result = await prepareCheckImage(overWideImage, async () => null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /3000px/);
      assert.match(result.error, /1500px/);
    }
  });

  it("returns an error when resize throws", async () => {
    const resize: ResizeImageFn = async () => {
      throw new Error("photon worker crashed");
    };

    const result = await prepareCheckImage(overWideImage, resize);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /photon worker crashed/);
  });
});

describe("buildCheckContent", () => {
  const signalsText = "No console errors, warnings, failed requests, or exceptions since last check.";

  it("puts the signals text first, then a label and image per screenshot", () => {
    const content = buildCheckContent(signalsText, [checkImage("viewport", "AAAA")]);

    assert.equal(content.length, 3);
    assert.deepEqual(content[0], { type: "text", text: signalsText });
    assert.equal(content[1].type, "text");
    assert.match((content[1] as { text: string }).text, /viewport 1440x900/);
    assert.deepEqual(content[2], { type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("keeps capture order for multiple screenshots (responsive)", () => {
    const content = buildCheckContent(signalsText, [
      checkImage("390px", "MOBILE"),
      checkImage("1440px", "DESKTOP"),
    ]);

    const images = content.filter((part) => part.type === "image");
    assert.deepEqual(
      images.map((part) => (part as { data: string }).data),
      ["MOBILE", "DESKTOP"],
    );
    assert.match((content[1] as { text: string }).text, /390px/);
    assert.match((content[3] as { text: string }).text, /1440px/);
  });

  it("labels previous and current screenshots before/after", () => {
    const content = buildCheckContent(
      signalsText,
      [checkImage("viewport", "AFTER")],
      checkImage("viewport", "BEFORE"),
    );

    assert.equal(content.length, 5);
    assert.match((content[1] as { text: string }).text, /before/);
    assert.deepEqual(content[2], { type: "image", data: "BEFORE", mimeType: "image/png" });
    assert.match((content[3] as { text: string }).text, /after/);
    assert.deepEqual(content[4], { type: "image", data: "AFTER", mimeType: "image/png" });
  });

  it("does not add before/after labels without a previous image", () => {
    const content = buildCheckContent(signalsText, [checkImage("viewport", "AAAA")]);
    assert.doesNotMatch((content[1] as { text: string }).text, /before|after/);
  });
});
