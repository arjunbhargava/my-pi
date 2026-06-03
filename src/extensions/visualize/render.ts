import sharp from "sharp";
import type { VisualizeRenderResult } from "./types.js";

/**
 * Rasterizes SVG markup to a PNG and returns the result as a base64 string.
 *
 * @param svg - Raw SVG markup to render.
 * @returns On success: `{ ok: true, imageBase64, widthPx, heightPx }`.
 *          On failure: `{ ok: false, error }` — never throws.
 */
export async function renderSvgToPng(svg: string): Promise<VisualizeRenderResult> {
  if (!svg || !svg.includes("<svg")) {
    return { ok: false, error: "Input does not appear to be SVG markup" };
  }

  try {
    const { data, info } = await sharp(Buffer.from(svg))
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
    return { ok: false, error: message };
  }
}
