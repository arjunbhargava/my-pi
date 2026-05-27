# Websearch Extension — Code Review

Reviewed against `docs/web-tools-gap-analysis.md`. All findings are grounded in the source files.

---

## Implemented vs Still-Open Status Table

| Gap from analysis | Status | Evidence |
|---|---|---|
| JS-rendered SPA extraction via Browserbase | **Implemented** | `src/extensions/websearch/browse.ts` — full `browsePageText()` with Playwright-core + `@browserbasehq/sdk` |
| `web_browse` tool registration | **Implemented** | `tools.ts:registerWebBrowseTool()` — 3 optional params: `extractSelector`, `waitForSelector`, `useProxy` |
| Cloudflare/CAPTCHA bypass via Browserbase | **Implemented** | `browse.ts` — `proxies: useProxy`, `solveCaptchas: true`, session recording |
| `BROWSERBASE_API_KEY_ENV` constant | **Implemented** | `types.ts:18` |
| `skills/web-tools/SKILL.md` documents all 3 tools | **Implemented** | Skill covers `web_search`, `web_fetch`, `web_browse` with parameters and workflow |
| Tests for `browse.ts` | **Implemented** | `tests/websearch-browse.test.ts` — 8 tests (normalizeText + missing-key + empty-key network call) |
| Domain filtering (`include_domains`/`exclude_domains`) | **Not implemented** | `search.ts:38–47` — POST body has only `query`, `max_results`, `include_answer`, `search_depth` |
| Search quality modes (`basic`/`advanced`) | **Not implemented** | `search.ts:46` — `search_depth` hardcoded to `"basic"` |
| Freshness control (`freshnessCutoff`) | **Not implemented** | No parameter in `search.ts` or `tools.ts` |
| PDF extraction | **Not implemented** | `fetch.ts:68–72` — hard-rejects non-HTML/plain with `Unsupported content type` |
| Objective-focused extraction | **Not implemented** | `fetch.ts:80` — positional `slice(0, maxChars)` only |
| Multi-query / objective-based search | **Not implemented** | `search.ts` sends one `query` string, no `objective` |
| Batch URL extraction (`web_fetch_batch`) | **Not implemented** | No such tool exists |
| Authenticated browser automation (Browser Use MCP) | **Not implemented** | No login/session capability anywhere |
| Parallel Extract API client | **Not implemented** | No `parallel-extract.ts` module exists |

---

## Code Quality: `browse.ts`

### Strengths

- Result type is `{ ok: true, value } | { ok: false, error }` — consistent with `fetch.ts` and `search.ts`.
- `finally { await browser?.close() }` guarantees cleanup even when navigation throws.
- Selector fallback: if `extractSelector` matches nothing, retries with `"body"` before returning an error.
- `normalizeText` is exported and has 6 dedicated unit tests.
- Error path for missing session creation (`bb.sessions.create` failure) is caught separately and returns a clean message before attempting a browser connection.

### Issues

**1. Silent failure on `networkidle` timeout — `browse.ts:121-123` (approx)**

```ts
await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
```

The `.catch(() => {})` discards any timeout or network error from `waitForLoadState`. The tool then extracts whatever content is on the page at that point and returns `ok: true`. The caller gets partial content with no indication that the load state wait failed. This is the single most likely source of unexplained empty/incomplete results in practice.

Fix: either log the error at minimum, or set a `truncated`-style flag `partialLoad: boolean` in `BrowsePageSuccess`.

**2. `waitForSelector` timeout hardcoded to 10s regardless of `timeoutMs` — `browse.ts:116`**

```ts
await page.waitForSelector(waitForSelector, { timeout: 10_000 });
```

The `timeoutMs` parameter only governs `page.goto`. If a caller passes `timeoutMs: 60_000` for a slow page, the `waitForSelector` still cuts off at 10s. This will throw into the outer catch, returning `ok: false` with a timeout message — not a silent failure, but surprising behaviour for the caller.

**3. `browser.contexts()[0].pages()[0]` is fragile — `browse.ts:98`**

When connecting to a Browserbase session over CDP, the first context and first page are expected to exist. If for any reason the context array is empty (session initialisation race, Browserbase API change), this throws `TypeError: Cannot read properties of undefined`. The error is caught by the outer catch block and returns a `Browse failed: ...` message — not silent, but the message will be cryptic.

**4. `recordSession: true` hardcoded — `browse.ts:87`**

Session recording is always on. This costs extra Browserbase credits per session. Not a correctness issue, but worth exposing as an option or defaulting to off.

**5. `solveCaptchas` and `timeoutMs` not exposed in the tool schema**

`tools.ts:registerWebBrowseTool` passes `useProxy` from the tool params but not `solveCaptchas` (hardcoded `true`) or `timeoutMs` (hardcoded `DEFAULT_BROWSE_TIMEOUT_MS = 30_000`). The defaults are sensible; this is a flexibility gap rather than a bug.

**6. Fragile timeout detection in outer catch — `browse.ts:140`**

```ts
if (err instanceof Error && err.message.toLowerCase().includes("timeout")) {
```

Playwright timeout messages are stable, but this string-match approach is brittle compared to checking `err.name === "TimeoutError"` (which Playwright sets on its timeout errors).

---

## Tavily Integration Completeness

| Feature | Supported by Tavily | Exposed in `search.ts` / `tools.ts` |
|---|---|---|
| `include_answer` | Yes | Yes — defaults to `true` |
| `max_results` (capped at 10) | Yes | Yes |
| `search_depth: "basic"` | Yes | Hardcoded — cannot select `"advanced"` |
| `include_domains` | Yes | No |
| `exclude_domains` | Yes | No |
| Authorization via Bearer token | Yes | Yes — `Authorization: Bearer ${apiKey}` |
| Result publish dates | Not in Tavily | N/A |
| Multi-query fan-out | Not in Tavily | N/A |

Domain filtering is a ~15-line change to `search.ts` (extend options object, add to request body) and a ~10-line change to `tools.ts` (add two `TypeOptional(TypeArray(TypeString()))` params to `web_search`). The gap analysis rated this Priority 1; it remains undone.

The `search_depth: "advanced"` mode is also supported by Tavily and would be a simple optional boolean/enum param addition.

---

## Error Path Audit

| Location | Path | Silent? |
|---|---|---|
| `fetch.ts` — network error | Returns `{ ok: false, error: "Network error: ..." }` | No |
| `fetch.ts` — HTTP non-2xx | Returns `{ ok: false, error: "HTTP 404: ..." }` | No |
| `fetch.ts` — unsupported content type | Returns `{ ok: false, error: "Unsupported content type: ..." }` | No |
| `fetch.ts` — body read failure | Returns `{ ok: false, error: "Failed to read response body: ..." }` | No |
| `search.ts` — network error | Returns `{ ok: false, error: "Network error: ..." }` | No |
| `search.ts` — HTTP error | Returns `{ ok: false, error: "Tavily API error: HTTP ..." }` | No |
| `search.ts` — malformed JSON | Returns `{ ok: false, error: "Tavily API returned malformed JSON" }` | No |
| `browse.ts` — session creation failure | Caught separately, returns clean error | No |
| `browse.ts` — CDP connect failure | Caught separately, returns clean error | No |
| `browse.ts` — `waitForLoadState` timeout | `.catch(() => {})` — **discards the error** | **Yes** |
| `browse.ts` — `waitForSelector` timeout | Propagates to outer catch, returns error | No |
| `browse.ts` — null innerText with default selector | Returns `{ ok: false, error: "No content found on page" }` | No |

One silent failure: `waitForLoadState("networkidle").catch(() => {})` in `browse.ts`.

---

## What Has No Tests

- `web_fetch` tool's `execute` handler — `tests/websearch-fetch.test.ts` tests `fetchPageText` and `extractTextFromHtml` directly but does not test the tool registration or the `execute` handler path (missing API key not applicable here, but truncation flag in output and `details` shape are untested at the tool level).
- `web_browse` tool's successful path — `tests/websearch-browse.test.ts` only tests `normalizeText` and the missing-API-key case. The happy path (successful extraction, `sessionId` in output, header format) has no test.
- `search.ts` request body shape when `includeAnswer: false` — there is a test for the `true` case but not for `false`.

---

## Summary

The Browserbase `web_browse` integration is the significant feature added since the gap analysis. It is structurally sound and follows the extension's error-handling patterns. The one real code quality issue is the silent discard of `waitForLoadState` errors — this will produce empty-content returns that look like success.

The two highest-value remaining gaps are:
1. Domain filtering on `web_search` — Tavily supports it, ~25 lines, zero external dependencies.
2. `search_depth: "advanced"` option — single string change to the Tavily request body, one new `TypeOptional` param.

PDF extraction and objective-focused ranking require either a new API dependency (Parallel Extract) or a local library, and are appropriately deferred.
