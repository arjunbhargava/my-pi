/**
 * Type definitions and constants for the pdf extension.
 * No logic — only type declarations and constants.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum characters to return from a single extraction. */
export const DEFAULT_MAX_CHARS = 50_000;

/** Separator inserted between pages when concatenating extracted text. */
export const PAGE_SEPARATOR = "\n\n";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A clamped, inclusive 1-based page range to extract. */
export interface PageRange {
  /** First page to extract (1-based, inclusive). */
  first: number;
  /** Last page to extract (1-based, inclusive). */
  last: number;
}

/** Successful PDF text extraction. */
export interface PdfExtractSuccess {
  /** Absolute or relative path the PDF was read from. */
  path: string;
  /** Extracted, page-separated text (possibly truncated). */
  text: string;
  /** Total number of pages in the document. */
  pageCount: number;
  /** The page range that was actually extracted. */
  extractedPages: PageRange;
  /** Document title from PDF metadata, if present. */
  title?: string;
  /** True if the text was truncated to the character limit. */
  truncated: boolean;
  /** Number of characters in the returned text. */
  charCount: number;
}

/** Discriminated result for {@link extractPdfText} and page-range parsing. */
export type PdfResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
