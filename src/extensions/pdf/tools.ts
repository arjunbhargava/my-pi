/**
 * Tool registration for the pdf extension.
 *
 * Takes a registrar callback and typebox constructors as parameters —
 * no direct imports from `@earendil-works/pi-coding-agent`.
 */

import { extractPdfText, parsePageRange } from "./extract.js";
import { DEFAULT_MAX_CHARS, type PdfExtractSuccess } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's registerTool uses complex generic types from typebox
type ToolRegistrar = (def: any) => void;

/**
 * Register the read_pdf tool.
 *
 * @param register     - The `pi.registerTool` function.
 * @param TypeObject   - `Type.Object` from typebox.
 * @param TypeString   - `Type.String` from typebox.
 * @param TypeOptional - `Type.Optional` from typebox.
 * @param TypeInteger  - `Type.Integer` from typebox.
 */
export function registerPdfTools(
  register: ToolRegistrar,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typebox schema constructors
  TypeObject: (...args: any[]) => any,
  TypeString: (...args: any[]) => any,
  TypeOptional: (...args: any[]) => any,
  TypeInteger: (...args: any[]) => any,
): void {
  register({
    name: "read_pdf",
    label: "Read PDF",
    description:
      "Extract text from a PDF file on disk. Returns the document's text content, page-separated, " +
      "with a header noting page count and title. Use the `pages` parameter to read a specific range " +
      "from large documents. Extracts digital text only — scanned/image-only PDFs have no extractable text.",
    promptSnippet: "Extract text from a PDF file on disk.",
    promptGuidelines: [
      "Use read_pdf to read PDF files; the standard read tool cannot parse PDF binary content.",
      "For large PDFs, pass a `pages` range (e.g. '1-10') instead of extracting the whole document at once.",
    ],
    parameters: TypeObject({
      path: TypeString({ description: "Path to the PDF file to read" }),
      pages: TypeOptional(TypeString({
        description: 'Page range to extract, e.g. "3", "2-5", or "4-". Defaults to the whole document.',
      })),
      maxChars: TypeOptional(TypeInteger({
        description: `Maximum characters to extract, default ${DEFAULT_MAX_CHARS}`,
      })),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const path = params.path as string;
      const pagesSpec = typeof params.pages === "string" ? params.pages : undefined;
      const maxChars = typeof params.maxChars === "number" ? params.maxChars : DEFAULT_MAX_CHARS;

      const range = parsePageRange(pagesSpec);
      if (!range.ok) {
        return { content: [{ type: "text", text: range.error }], details: {}, isError: true };
      }

      const result = await extractPdfText({
        path,
        firstPage: range.value.first,
        lastPage: range.value.last,
        maxChars,
      });
      if (!result.ok) {
        return { content: [{ type: "text", text: `PDF read failed: ${result.error}` }], details: {}, isError: true };
      }

      return {
        content: [{ type: "text", text: formatPdfOutput(result.value) }],
        details: {
          path: result.value.path,
          pageCount: result.value.pageCount,
          extractedPages: result.value.extractedPages,
          charCount: result.value.charCount,
          truncated: result.value.truncated,
        },
      };
    },
  });
}

/** Build the human-readable tool output: a metadata header followed by the extracted text. */
function formatPdfOutput(result: PdfExtractSuccess): string {
  const { first, last } = result.extractedPages;
  const pageNote = first === 1 && last === result.pageCount
    ? `${result.pageCount} pages`
    : `pages ${first}-${last} of ${result.pageCount}`;
  const truncatedNote = result.truncated ? ", truncated" : "";
  const titleLine = result.title ? `\n[Title: ${result.title}]` : "";
  const header = `[Read PDF: ${result.path}]${titleLine}\n[${pageNote}, ${result.charCount} chars${truncatedNote}]\n\n`;

  const body = result.text.trim() === ""
    ? "(No extractable text. The PDF may be scanned or image-only; OCR is not supported.)"
    : result.text;

  return header + body;
}
