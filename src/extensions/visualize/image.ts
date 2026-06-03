import { readFile } from "node:fs/promises";
import sharp from "sharp";

/**
 * Discriminated union returned by `loadImageToPng`.
 * On success, carries the PNG payload as base64 and the rasterised dimensions.
 * On failure, carries a human-readable explanation; never throws.
 */
export type ImageLoadResult =
  | { ok: true; imageBase64: string; widthPx: number; heightPx: number }
  | { ok: false; error: string };

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
 *   3. Filesystem path — anything else is tried with `fs.readFile` first.
 *      If the string starts with "/" or "." it is treated as an unambiguous
 *      path: ENOENT produces `{ ok: false }` with the path in the error.
 *      For other strings the filesystem is checked before base64 to avoid
 *      misreading a real file whose name happens to be valid base64; ENOENT
 *      for those strings falls through to step 4.
 *   4. Raw base64 — catch-all for strings that are not paths/URLs/data-URIs.
 *      The string is decoded to a Buffer and passed to sharp.
 *
 * @param source - Image source: data-URI, http(s) URL, filesystem path, or
 *                 raw base64 string.
 * @returns `{ ok: true, imageBase64, widthPx, heightPx }` on success, or
 *          `{ ok: false, error }` on any failure — never throws.
 */
export async function loadImageToPng(source: string): Promise<ImageLoadResult> {
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

  // Strings starting with "/" or "." are unambiguously filesystem paths.
  // For everything else, still check the filesystem first (before base64) to
  // avoid misinterpreting a real filename as a base64 payload. If the file is
  // not found and the source was clearly a path, report the error; otherwise
  // fall through to the raw-base64 fallback.
  const isExplicitPath = source.startsWith("/") || source.startsWith(".");
  const fileResult = await tryReadFile(source);

  if (fileResult.ok) return { ok: true, value: fileResult.value };
  if (isExplicitPath || !fileResult.notFound) return { ok: false, error: fileResult.error };

  return decodeRawBase64(source);
}

function decodeDataUri(source: string): BufferResult {
  const commaIndex = source.indexOf(",");
  if (commaIndex === -1) {
    return { ok: false, error: "Malformed data-URI: missing comma separator" };
  }
  try {
    const payload = source.slice(commaIndex + 1);
    return { ok: true, value: Buffer.from(payload, "base64") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `data-URI decode failed: ${message}` };
  }
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
  | { ok: false; error: string; notFound: boolean };

async function tryReadFile(source: string): Promise<FileReadResult> {
  try {
    const buf = await readFile(source);
    return { ok: true, value: buf };
  } catch (err) {
    const isNotFound =
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not read file "${source}": ${message}`,
      notFound: isNotFound,
    };
  }
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

async function normaliseToPng(buffer: Buffer): Promise<ImageLoadResult> {
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
