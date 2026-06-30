import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { VisualizeRenderResult } from "./types.js";

/** Canonical base64: base64 alphabet followed by 0-2 padding chars. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Minimum length for a string to be treated as a raw base64 image payload.
 * Guards against short filesystem names that happen to be base64-shaped.
 */
const MIN_BASE64_LENGTH = 16;

/**
 * Loads an image from any of the supported source forms, normalises it to PNG
 * via sharp, and returns the result as a base64 string with dimensions.
 *
 * Accepted source forms, detected in this order:
 *   1. data-URI   — starts with "data:image/" and contains ";base64,".
 *      The base64 payload after the comma is decoded to a Buffer.
 *   2. http(s) URL — starts with "http://" or "https://".
 *      Bytes are fetched with the global `fetch`; non-2xx responses are
 *      returned as `{ ok: false }`.
 *   3. Filesystem path — anything else is tried with `fs.readFile` first, so a
 *      real file is never misread as a base64 payload. A failure that is not
 *      "path cannot name a file" (permissions, EISDIR) is returned as
 *      `{ ok: false }`.
 *   4. Raw base64 — when the path cannot name an existing file (ENOENT, or
 *      ENAMETOOLONG because the string exceeds PATH_MAX), a base64-shaped
 *      string (see `looksLikeBase64`) is decoded and passed to sharp. This
 *      covers JPEG payloads, which begin with "/9j/" and would otherwise look
 *      like an absolute path, and any image whose base64 is longer than the OS
 *      path limit. A missing path that is not base64-shaped returns the
 *      original file error so genuine missing-path mistakes get a clear
 *      message.
 *
 * @param source - Image source: data-URI, http(s) URL, filesystem path, or
 *                 raw base64 string.
 * @returns `{ ok: true, imageBase64, widthPx, heightPx }` on success, or
 *          `{ ok: false, error }` on any failure — never throws.
 */
export async function loadImageToPng(source: string): Promise<VisualizeRenderResult> {
  const buffer = await resolveToBuffer(source);
  if (!buffer.ok) return buffer;
  return normaliseToPng(buffer.value);
}

type BufferResult =
  | { ok: true; value: Buffer }
  | { ok: false; error: string };

async function resolveToBuffer(source: string): Promise<BufferResult> {
  if (source.startsWith("data:image/") && source.includes(";base64,")) {
    return decodeDataUri(source);
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return fetchUrl(source);
  }

  // Check the filesystem first (before base64) to avoid misinterpreting a real
  // filename as a base64 payload. A failure that means "this can't name an
  // existing file" (ENOENT, or ENAMETOOLONG for a string longer than PATH_MAX)
  // falls through to raw base64 if the string is base64-shaped — crucially this
  // covers JPEG payloads, which begin with "/9j/" and would otherwise be misread
  // as an absolute path, and any image large enough that its base64 exceeds the
  // OS path-length limit. Other failures (permissions, EISDIR) are reported
  // as-is. If the unusable string is not base64-shaped, surface the original
  // file error so genuine missing-path mistakes get a clear message instead of a
  // decode failure.
  const fileResult = await tryReadFile(source);

  if (fileResult.ok) return { ok: true, value: fileResult.value };
  if (!fileResult.pathUnusable) return { ok: false, error: fileResult.error };
  if (looksLikeBase64(source)) return decodeRawBase64(source);
  if (source.startsWith("/") || source.startsWith(".")) {
    return { ok: false, error: fileResult.error };
  }

  return decodeRawBase64(source);
}

function decodeDataUri(source: string): BufferResult {
  const commaIndex = source.indexOf(",");
  if (commaIndex === -1) {
    return { ok: false, error: "Malformed data-URI: missing comma separator" };
  }
  return { ok: true, value: Buffer.from(source.slice(commaIndex + 1), "base64") };
}

async function fetchUrl(url: string): Promise<BufferResult> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Fetch failed for ${url}: ${message}` };
  }

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} fetching ${url}` };
  }

  try {
    const ab = await res.arrayBuffer();
    return { ok: true, value: Buffer.from(ab) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to read response body from ${url}: ${message}`,
    };
  }
}

type FileReadResult =
  | { ok: true; value: Buffer }
  | { ok: false; error: string; pathUnusable: boolean };

/**
 * Errno codes that mean the source string cannot name an existing file, so the
 * caller should fall through to interpreting it as a base64 payload:
 *   - ENOENT:       no such file.
 *   - ENAMETOOLONG: string is longer than PATH_MAX — every realistically sized
 *                   raw base64 image lands here, never reaching ENOENT.
 */
const PATH_UNUSABLE_CODES = new Set(["ENOENT", "ENAMETOOLONG"]);

/** Max chars of `source` to echo in an error so a base64 payload is not dumped. */
const MAX_SOURCE_IN_ERROR = 64;

async function tryReadFile(source: string): Promise<FileReadResult> {
  try {
    const buf = await readFile(source);
    return { ok: true, value: buf };
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    const isPathUnusable = code !== undefined && PATH_UNUSABLE_CODES.has(code);
    // Prefer the errno code over `err.message`: Node embeds the full path in the
    // message, which for a base64-shaped source would dump the whole payload.
    const detail = code ?? (err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      error: `Could not read file "${truncateSource(source)}": ${detail}`,
      pathUnusable: isPathUnusable,
    };
  }
}

/** Truncate an over-long source string for inclusion in user-facing errors. */
function truncateSource(source: string): string {
  return source.length > MAX_SOURCE_IN_ERROR
    ? `${source.slice(0, MAX_SOURCE_IN_ERROR)}… (${source.length} chars)`
    : source;
}

/**
 * Heuristic: does the string look like a canonical base64 payload large enough
 * to be an image? Used to decide whether a not-found filesystem path should
 * fall through to base64 decoding (JPEG base64 begins with "/", colliding with
 * the absolute-path heuristic).
 *
 * @param source - Candidate string.
 * @returns true if the string is long enough and matches canonical base64.
 */
function looksLikeBase64(source: string): boolean {
  return (
    source.length >= MIN_BASE64_LENGTH &&
    source.length % 4 === 0 &&
    BASE64_PATTERN.test(source)
  );
}

function decodeRawBase64(source: string): BufferResult {
  try {
    const buf = Buffer.from(source, "base64");
    if (buf.length === 0) {
      return {
        ok: false,
        error: "Source is not a recognisable image (empty after base64 decode)",
      };
    }
    return { ok: true, value: buf };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Raw base64 decode failed: ${message}` };
  }
}

async function normaliseToPng(buffer: Buffer): Promise<VisualizeRenderResult> {
  try {
    const { data, info } = await sharp(buffer)
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      ok: true,
      imageBase64: data.toString("base64"),
      widthPx: info.width,
      heightPx: info.height,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `sharp could not parse image: ${message}` };
  }
}
