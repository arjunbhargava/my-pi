---
name: pdf-tools
description: Extract text from PDF files on disk. Use when you need to read a PDF; the standard read tool cannot parse PDF binary content.
---

# PDF Tools

## Tools

### `read_pdf`

Extracts text from a PDF file on disk, backed by `unpdf` (a bundled serverless build of Mozilla's PDF.js). Returns the document's text content, page-separated, with a header noting page count and title.

Parameters:
- `path` (required) — path to the PDF file to read
- `pages` (optional) — page range to extract, e.g. `"3"`, `"2-5"`, or `"4-"`. Defaults to the whole document.
- `maxChars` (optional) — maximum characters to extract, default 50000

No API key needed. No native binaries required — the PDF.js build is bundled with the extension.

## Workflow

1. **Use `read_pdf` for PDFs.** The standard `read` tool reads bytes and cannot parse PDF structure.
2. **Page-range large documents.** For long PDFs, pass a `pages` range (e.g. `"1-10"`) instead of extracting everything at once. Out-of-range bounds are clamped to the document.
3. **Digital text only.** `read_pdf` extracts embedded text. Scanned or image-only PDFs yield no text — there is no OCR. The tool reports this explicitly rather than failing.
