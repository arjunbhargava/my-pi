---
name: web-tools
description: Web search and page fetching via Tavily. Use when you need information not in the local codebase.
---

# Web Tools

## Tools

### `web_search`

Searches the web via the Tavily API. Returns titles, URLs, content snippets, and an optional synthesized answer.

Parameters:
- `query` (required) — search query string
- `resultCount` (optional) — number of results, 1–10, default 5

Requires `TAVILY_API_KEY` environment variable.

### `web_fetch`

Fetches a single URL and extracts readable text. Strips HTML tags, scripts, and navigation elements. Truncates to `maxChars`.

Parameters:
- `url` (required) — URL to fetch
- `maxChars` (optional) — maximum characters to extract, default 6000

No API key needed. No credits consumed.

## Workflow

1. **Search first.** Snippets from `web_search` are often sufficient.
2. **Fetch only if needed.** If snippets lack the detail you need, call `web_fetch` on the single most relevant URL.
3. **Do not speculatively fetch multiple URLs.** Read what you get; fetch more only if that one result is still insufficient.
