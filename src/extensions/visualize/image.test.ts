import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { loadImageToPng } from "./image.js";

const FIXTURE_WIDTH = 64;
const FIXTURE_HEIGHT = 48;
const FIXTURE_PATH = join(tmpdir(), `image-test-fixture-${process.pid}.png`);

let fixtureBase64: string;
let jpegBase64: string;
let largeBase64: string;

before(async () => {
  const { data } = await sharp({
    create: {
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      channels: 3,
      background: { r: 255, g: 128, b: 0 },
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });

  await writeFile(FIXTURE_PATH, data);
  fixtureBase64 = data.toString("base64");

  // A JPEG payload: its base64 begins with "/9j/", which collides with the
  // absolute-path heuristic and is the regression this fixture guards.
  const jpeg = await sharp({
    create: {
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      channels: 3,
      background: { r: 40, g: 200, b: 80 },
    },
  })
    .jpeg()
    .toBuffer();
  jpegBase64 = jpeg.toString("base64");

  // A raw base64 payload whose length exceeds PATH_MAX. Noise is used so the
  // PNG does not compress below the limit. fs.readFile on a string this long
  // throws ENAMETOOLONG (not ENOENT); the regression is that the loader must
  // still fall through to base64 decoding rather than report a file error.
  const noise = Buffer.alloc(FIXTURE_WIDTH * FIXTURE_HEIGHT * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(Math.random() * 256);
  const largePng = await sharp(noise, {
    raw: { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, channels: 3 },
  })
    .png()
    .toBuffer();
  largeBase64 = largePng.toString("base64");
});

after(async () => {
  await unlink(FIXTURE_PATH).catch(() => undefined);
});

describe("loadImageToPng", () => {
  it("loads a PNG from a filesystem path", async () => {
    const result = await loadImageToPng(FIXTURE_PATH);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.widthPx, FIXTURE_WIDTH);
    assert.equal(result.heightPx, FIXTURE_HEIGHT);
    assert.ok(result.imageBase64.length > 0);
  });

  it("loads a PNG from a data-URI", async () => {
    const dataUri = `data:image/png;base64,${fixtureBase64}`;
    const result = await loadImageToPng(dataUri);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.widthPx, FIXTURE_WIDTH);
    assert.equal(result.heightPx, FIXTURE_HEIGHT);
  });

  it("loads a PNG from raw base64", async () => {
    const result = await loadImageToPng(fixtureBase64);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.widthPx, FIXTURE_WIDTH);
    assert.equal(result.heightPx, FIXTURE_HEIGHT);
  });

  it("loads a JPEG from raw base64 even though it begins with a slash", async () => {
    assert.ok(jpegBase64.startsWith("/"), "precondition: JPEG base64 starts with /");
    const result = await loadImageToPng(jpegBase64);
    if (!result.ok) assert.fail(`expected ok, got error: ${result.error}`);
    assert.equal(result.widthPx, FIXTURE_WIDTH);
    assert.equal(result.heightPx, FIXTURE_HEIGHT);
  });

  it("loads raw base64 longer than PATH_MAX (ENAMETOOLONG path probe)", async () => {
    assert.ok(
      largeBase64.length > 4096,
      `precondition: base64 must exceed PATH_MAX, got ${largeBase64.length}`,
    );
    const result = await loadImageToPng(largeBase64);
    if (!result.ok) assert.fail(`expected ok, got error: ${result.error}`);
    assert.equal(result.widthPx, FIXTURE_WIDTH);
    assert.equal(result.heightPx, FIXTURE_HEIGHT);
  });

  it("returns ok:false for a missing filesystem path", async () => {
    const missing = "/nonexistent/x.png";
    const result = await loadImageToPng(missing);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(
      result.error.includes("nonexistent") || result.error.includes("x.png"),
      `Expected path in error, got: ${result.error}`,
    );
  });

  describe("URL fetch", () => {
    const originalFetch = globalThis.fetch;

    after(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetches a 200 response and returns ok:true", async () => {
      const pngBytes = Buffer.from(fixtureBase64, "base64");
      globalThis.fetch = async (_url: string | URL | Request) => {
        return new Response(pngBytes, { status: 200 });
      };

      const result = await loadImageToPng("https://example.com/test.png");
      if (!result.ok) assert.fail(result.error);
      assert.equal(result.widthPx, FIXTURE_WIDTH);
      assert.equal(result.heightPx, FIXTURE_HEIGHT);
    });

    it("returns ok:false for a non-200 response", async () => {
      globalThis.fetch = async (_url: string | URL | Request) => {
        return new Response("not found", { status: 404 });
      };

      const result = await loadImageToPng("https://example.com/missing.png");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.ok(
        result.error.includes("404"),
        `Expected 404 in error, got: ${result.error}`,
      );
    });

    it("returns ok:false for a 200 response with non-image bytes", async () => {
      globalThis.fetch = async (_url: string | URL | Request) => {
        return new Response("this is not an image", { status: 200 });
      };

      const result = await loadImageToPng("https://example.com/text.txt");
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assert.ok(result.error.length > 0);
    });
  });

  it("does not echo an over-long source verbatim in error messages", async () => {
    // An absolute path far longer than PATH_MAX that is not base64-shaped:
    // ENAMETOOLONG, not base64-decodable, so it surfaces a file error — but the
    // error must be truncated, not the full multi-KB string.
    const longBogusPath = "/" + "a b".repeat(3000);
    const result = await loadImageToPng(longBogusPath);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(
      result.error.length < longBogusPath.length,
      `error should be truncated, was ${result.error.length} chars`,
    );
    assert.ok(result.error.includes("chars)"), `expected length annotation, got: ${result.error}`);
  });

  it("returns ok:false for a non-image garbage string", async () => {
    const result = await loadImageToPng("not-an-image-or-path-or-url-$$$$$$");
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.error.length > 0);
  });
});
