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

### `web_browse`

Opens a Browserbase cloud browser to fetch JS-rendered page content. Handles Cloudflare protection, CAPTCHAs, and JavaScript-heavy SPAs. Returns extracted text in the same format as `web_fetch`.

Parameters:
- `url` (required) — URL to navigate to
- `maxChars` (optional) — maximum characters to extract, default 6000
- `extractSelector` (optional) — CSS selector to extract text from, default `"body"`. Use `"main"` or `"article"` to skip nav/footer.
- `waitForSelector` (optional) — CSS selector to wait for before extracting, e.g. `"#content"`
- `useProxy` (optional) — route through residential proxies for Cloudflare bypass, default true

Requires `BROWSERBASE_API_KEY` environment variable. Costs Browserbase credits per session.

## Workflow

1. **Search first.** Snippets from `web_search` are often sufficient.
2. **Fetch if needed.** If snippets lack detail, call `web_fetch` on the most relevant URL.
3. **Browse if blocked.** If `web_fetch` fails (Cloudflare block, empty content, JS-rendered SPA), use `web_browse`.
4. **Do not speculatively browse multiple URLs.** `web_browse` is slower and costs credits.
