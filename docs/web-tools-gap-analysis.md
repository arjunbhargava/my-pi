# Web Tools Gap Analysis: Current vs Parallel.ai

## Executive Summary

Our current web tools extension provides two thin, synchronous primitives: a Tavily-backed keyword search and a raw-HTTP page fetcher that strips HTML. Parallel.ai's API suite covers the same two primitives but also offers JS-rendering, PDF extraction, objective-focused relevance ranking, batch URL processing, structured deep research, entity discovery, change monitoring, and cloud browser automation for authenticated content. The gap is wide on anything beyond simple public-page lookup.

## Feature Comparison Matrix

| Capability | Our Implementation | Parallel.ai | Gap |
|---|---|---|---|
| Web search | Tavily: 1 keyword query → snippets, optional synthesized answer | Search API: natural-language objective + multiple keyword queries → LLM-optimized excerpts, basic/advanced modes, max_results up to 10, publish_date | Objective framing, multi-query fan-out, quality modes, result dates |
| Page extraction | Raw HTTP GET → regex HTML strip → positional truncation | Extract API: JS rendering + PDF → clean markdown, objective-focused ranked excerpts, full_content option | JS rendering, PDF support, relevance ranking, full_content flag |
| Batch URL extraction | None — one URL per call | Extract API: up to 20 URLs per request in one round-trip | Batch capability |
| Source policy | None | Search API + Task API: `include_domains`, `exclude_domains`, `freshness_date` | Domain filtering, freshness control |
| Search quality modes | Fixed `search_depth: "basic"` (Tavily) | `basic` (low latency) / `advanced` (higher quality) | No quality-latency tradeoff knob |
| Structured output | None | Task API: JSON schema, text schema, auto; with citations and confidence levels | All structured output |
| Deep / async research | None | Task API (async, processor tiers: base/core/ultra), multi-turn interactions | All deep research |
| Entity discovery | None | FindAll API: natural-language entity generation + validation + enrichment | Entire category missing |
| Change monitoring | None | Monitor API: scheduled queries, webhook delivery | Entire category missing |
| PDF handling | Rejected with "Unsupported content type" | Extract API: PDFs converted to LLM-ready markdown automatically | PDFs silently fail today |
| JS-heavy SPA rendering | None — static HTTP GET returns empty/boilerplate for React/Vue/Next apps | Extract API: headless rendering, handles any public URL | SPAs return garbage today |
| Objective-focused extraction | None — positional `slice(0, maxChars)` | Extract API: excerpt ranking aligned to `objective`; returns only relevant sections | Relevance ranking missing |
| Browser automation | None | Browser Use MCP: cloud-hosted browser for authenticated pages, form filling, multi-step navigation | Entire category missing |
| Authenticated content | None | Browser Use MCP + saved login profiles | Entirely absent |
| Session tracking | None | `session_id` on every Search/Extract call; server echoes it back for correlation | No cross-call correlation |
| Freshness control | None | `source_policy.freshness_date` on Search + Task | Cannot restrict to recent content |
| Chat / grounded chatbot | None | Chat API: OpenAI-compatible streaming with web-grounded responses | Entire category |
| Streaming / real-time progress | None | Task API: SSE streaming events | Long-running tasks block silently |
| MCP server | None — extension only works inside pi | Parallel Search MCP: `https://search.parallel.ai/mcp`, free tier, works in any MCP client | Not portable across clients |

---

## Detailed Analysis

### What we do well

- **Zero external dependency for fetch** — `web_fetch` makes a direct HTTP call; no API key or credits consumed for simple public pages.
- **Predictable, auditable HTML stripping** — the regex pipeline in `fetch.ts` is easy to read, test, and debug; 100% test coverage on the extraction logic.
- **Clean error handling** — every failure path returns a typed `{ ok: false, error }` result rather than throwing; tests cover all failure modes explicitly.
- **No coupling to Tavily in the fetch path** — `fetch.ts` imports nothing from Tavily; swapping the search backend does not touch the fetch code.
- **Env-var-at-call-time** — `TAVILY_API_KEY` is read from `process.env` inside `execute()`, not at registration time. This means the key can be injected after the extension loads, which matters for the recently-landed env var propagation work (see note on env var propagation below).

### Critical Gaps

#### 1. JS-Heavy Page Rendering

`fetch.ts` issues a plain `fetch()` GET. JavaScript-rendered SPAs (React, Next.js, Vue, Angular) return an empty shell with `<div id="root"></div>` and no visible content. Docs sites, dashboards, and most modern product pages fall into this category.

**What to do:**
- **Option A (local):** Add a `web_browse` tool backed by [Playwright](https://playwright.dev/) (`playwright` npm package). Launches a headless Chromium, navigates to the URL, waits for network idle, and serialises `document.body.innerText`. Fully offline; larger dependency (~100 MB Chromium binary). Affected files: add `src/extensions/websearch/browse.ts`, register new tool in `tools.ts`.
- **Option B (cloud):** Call Parallel Extract API directly. No Playwright binary needed; handles JS + PDF automatically. Costs $0.001/request. Affected files: add `src/extensions/websearch/parallel.ts`, new tool registration in `tools.ts`.
- **Option C (hybrid):** Keep plain fetch as default, fall back to a headless browser only when content-length is suspiciously small (< 500 chars). Adds heuristic fragility.

**Recommendation:** Option B for an immediate fix (low complexity, handles PDFs too); Option A if offline/no-API-cost is a priority.

#### 2. PDF Extraction

`fetch.ts` hard-rejects anything that isn't `text/html` or `text/plain`:
```ts
return { ok: false, error: `Unsupported content type: ${bare}` };
```
PDFs are ubiquitous in technical and legal research. Today they silently fail with an opaque error.

**What to do:**
- **Option A:** Add a `pdf.ts` module using [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) or [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist). Download the response bytes, parse, extract text. No external API.
- **Option B:** Route `application/pdf` URLs through the Parallel Extract API (handles PDFs natively, returns markdown).
- **Complexity:** Small (Option A); Small (Option B). Both touch `fetch.ts` content-type branch only.

#### 3. Objective-Focused Extraction

Our extraction is purely positional: `extracted.slice(0, maxChars)`. For a 200-page technical document, the first 6,000 characters are usually boilerplate (table of contents, disclaimers, navigation). The agent never gets to the relevant section unless it manually increases `maxChars`.

Parallel Extract returns **ranked excerpts** when given an `objective` string — only the passages most relevant to the goal are returned, skipping boilerplate. This is the most important quality difference between the two approaches.

**What to do:**
- Add an `objective` parameter to `web_fetch` tool definition. If provided, route to Parallel Extract; otherwise, fall back to current plain fetch.
- Affected files: `tools.ts` (add `objective` param), new `parallel-extract.ts` client module, `types.ts` (add `PARALLEL_API_KEY_ENV`).
- **Complexity:** Medium. Requires handling the async Parallel Extract call and a second API key.

#### 4. Multi-Query / Objective-Based Search

`searchWeb()` sends a single `query` string and uses `search_depth: "basic"` (Tavily's lowest quality tier). Parallel Search takes:
- A natural-language `objective` (broader context for ranking)
- Multiple `search_queries` (2–5 targeted keyword queries run in parallel)
- A `mode` of `basic` or `advanced`

This means a single Parallel Search call can fan out across several angles simultaneously, returning more comprehensive, higher-quality excerpts.

**What to do:**
- Add an `objective` parameter to `web_search` tool; map it to Tavily's equivalent if supported, or migrate `search.ts` to the Parallel Search API.
- Note: Tavily does not support multi-query fan-out or an `advanced` mode; this gap may require replacing Tavily with Parallel Search.
- Affected files: `search.ts`, `tools.ts`, `types.ts`.
- **Complexity:** Medium (if migrating search backend); Small (if keeping Tavily but adding `objective` as a hint).

#### 5. Source Policy (Domain Filtering + Freshness)

No way to restrict searches or extractions to specific domains, or to require results be published after a given date. For competitive research ("only look at LinkedIn"), security research ("only look at CVE databases"), or recency-sensitive tasks ("news from the last 7 days"), this is a significant missing feature.

**What to do:**
- Add `includeDomains`, `excludeDomains`, `freshnessCutoff` (ISO date string) as optional parameters to `web_search`.
- Tavily supports `include_domains` and `exclude_domains`; add them to `searchWeb()` and the tool schema.
- `freshnessCutoff` is not a Tavily feature; would require Parallel Search API.
- Affected files: `search.ts` (extend request body), `tools.ts` (extend schema), `types.ts`.
- **Complexity:** Small for domain filtering (Tavily already supports it); Medium for freshness (requires Parallel Search).

#### 6. Browser Automation for Authenticated Content

There is no mechanism to access pages that require login, session cookies, OAuth tokens, or paywalls. Examples: internal Notion docs, LinkedIn profile pages, Salesforce records, Substack articles.

See **Browser Automation Deep Dive** section below.

#### 7. Batch URL Extraction

`web_fetch` accepts exactly one URL. Processing a list of 20 URLs requires 20 serial round-trips. Parallel Extract accepts up to 20 URLs in a single request.

**What to do:**
- Add a `web_fetch_batch` tool that accepts `urls: string[]` (max 20) and an optional `objective`.
- Route to Parallel Extract API.
- Affected files: add `web_fetch_batch` registration block in `tools.ts`, `parallel-extract.ts` client.
- **Complexity:** Small once Parallel Extract client exists.

### Nice-to-Have Gaps

- **Session IDs across related calls** — Parallel suggests passing the same `session_id` across Search + Extract calls for one task. Allows Parallel to correlate calls and optimize. Our tools have no concept of a task session. Low priority unless switching to Parallel APIs.
- **Result publish dates** — Parallel Search returns `publish_date` per result; Tavily does not. Useful for news/freshness-sensitive queries.
- **FindAll (entity discovery)** — "find all AI companies that raised Series A in 2024" as a single API call. No equivalent and far outside scope of current extension.
- **Monitor API (change tracking)** — scheduled webhook-based monitoring. Out of scope for an interactive coding agent.
- **Chat API** — OpenAI-compatible streaming chat with web grounding. Could replace the whole extension for some use cases but would require substantial architectural change.
- **Streaming task progress** — Task API supports SSE events for long-running tasks. Not relevant until we add a Task-equivalent tool.

---

## Recommended Improvements (Prioritized)

### Priority 1: Domain filtering on `web_search` (small effort, immediate utility)

Tavily already accepts `include_domains` and `exclude_domains` in its POST body. We never expose them.

**What to change:**
- `src/extensions/websearch/search.ts` — add `includeDomains?: string[]` and `excludeDomains?: string[]` to the options object; pass them in the request body.
- `src/extensions/websearch/tools.ts` — add optional `TypeArray(TypeString())` params for `includeDomains` and `excludeDomains` in the `web_search` schema.
- `src/extensions/websearch/types.ts` — document the new fields.
- `tests/websearch.test.ts` — add test verifying the fields are forwarded in the request body.
- **Complexity:** Small (< 30 lines of change).

### Priority 2: PDF + JS-rendering via Parallel Extract API (medium effort, eliminates the two biggest failure modes)

Replace the hard content-type rejection in `fetch.ts` with a fallback to Parallel Extract for PDF and JS-heavy content.

**What to build:**
- New file `src/extensions/websearch/parallel-extract.ts` — Parallel Extract API client mirroring the structure of `search.ts`. Accepts `urls`, `objective`, `apiKey`; returns `{ ok, value }`.
- Extend `web_fetch` tool in `tools.ts` to accept an optional `objective` string. If `objective` is provided or the URL returns a non-HTML/plain content type, call Parallel Extract instead of `fetchPageText`.
- New env var `PARALLEL_API_KEY_ENV = "PARALLEL_API_KEY"` in `types.ts`.
- Fallback behaviour: if `PARALLEL_API_KEY` is absent, document the degradation in the error message.
- **Files affected:** `types.ts`, `tools.ts`, new `parallel-extract.ts`.
- **Complexity:** Medium (~150 lines of new code, tests for the new client).

> **Objective-based search:** deferred — user will implement independently.

---

## Browser Automation Deep Dive

### Current state

There is no browser automation in the extension. `fetch.ts` makes a single `fetch()` call — no cookie jar, no JS execution, no form interaction. Any page that requires authentication or executes JavaScript to render content is inaccessible.

### Why this matters

Modern web content increasingly falls into one of two categories:
1. **JS-rendered SPAs** — React/Next/Angular apps that return an empty HTML shell until JS runs. A raw `fetch()` returns boilerplate, not content. Documentation sites, dashboards, SaaS product pages.
2. **Authenticated content** — LinkedIn profiles, internal wikis, paywalled articles, CRM records. Even if fully rendered, they require a session cookie that a headless browser can carry.

### Options evaluated

#### Option A: Playwright (local headless Chromium)

- **What it is:** Microsoft's browser automation library. Launches a Chromium process, navigates the page, returns `document.body.innerText` or `page.content()` after `waitForLoadState('networkidle')`.
- **Pros:** Fully offline, no external API cost, very mature, handles all JS rendering, can inject cookies for authenticated sessions, full control over timeouts and selectors.
- **Cons:** ~100 MB Chromium binary download per machine, adds a subprocess dependency, requires `playwright install` step in setup docs, slower startup than a pure HTTP call (~2–5s cold vs ~500ms warm).
- **Authenticated content:** Possible by loading a `storageState.json` (Playwright's saved cookie/localStorage file), but the user must manually capture that state first.
- **Relevant code change:** Add `src/extensions/websearch/browse.ts` with a `browseUrl()` function; register a `web_browse` tool in `tools.ts`. The extension entry point stays clean.

#### Option B: Puppeteer (local headless Chrome)

- **What it is:** Google's earlier browser automation library (Playwright's predecessor). Similar capabilities.
- **Pros:** Older, more Stack Overflow coverage. Chrome DevTools Protocol-native.
- **Cons:** More limited cross-browser support (Chromium only), slower API evolution than Playwright, identical binary size problem. No material advantage over Playwright for this use case.
- **Recommendation:** Prefer Playwright over Puppeteer.

#### Option C: Browser Use MCP (cloud-hosted browser, Parallel.ai integration)

- **What it is:** Browser Use (browseruse.com) provides a cloud-hosted browser controlled via MCP. Parallel's Task API can call into it via the `mcp_servers` field. The browser can carry **saved login profiles** (persistent cookie storage) so it can access authenticated pages.
- **How it works:** 
  1. User creates a Browser Use profile at browseruse.com and logs into target sites.
  2. Agent sends Task API request with `mcp_servers: [{ url: "https://api.browser-use.com/mcp", headers: { Authorization: "Bearer <BROWSERUSE_KEY>" } }]`.
  3. Parallel's Task API calls the Browser Use MCP tools (`browser_task`, `monitor_task`, `list_browser_profiles`) to navigate and extract content.
- **Pros:** No local binary, handles truly complex multi-step workflows (fill forms, click buttons), profiles persist across sessions, clean separation between browser credential management and the agent.
- **Cons:** Requires two API keys (Parallel + Browser Use), adds latency (cloud round-trips), costs money (Parallel Task `ultra` processor + Browser Use credits), currently in beta (`parallel-beta: mcp-server-2025-07-17` header required).
- **Authenticated content:** Best option for this use case — profiles carry login sessions and cookies automatically.

#### Option D: Browserbase or similar BaaS (Browser-as-a-Service)

- **What it is:** Browserbase, Bright Data Scraping Browser, ScrapingBee, Apify. Cloud-hosted headless browsers accessible via REST or WebSocket. Handle anti-bot measures, proxies, CAPTCHA solving, and session management at scale.
- **Pros:** Explicitly solves Cloudflare Turnstile, reCAPTCHA, and advanced bot fingerprinting that local Playwright — even with `playwright-extra` stealth — cannot reliably bypass. Managed infrastructure; no local binary. Some (Bright Data) include residential proxy rotation, geolocation, and headful browser profiles.
- **Cons:** Cost per session or per GB; vendor lock-in; added latency vs. local execution; not needed if target sites don't use advanced bot detection.
- **Cloudflare reality:** Stealth plugins (`puppeteer-extra-plugin-stealth`) achieve roughly 60–80% bypass rates against basic Cloudflare checks and fail against Cloudflare Turnstile or sites with advanced behavioral analysis. BaaS providers that run headful browsers with real residential IPs consistently exceed 90% success rates on Cloudflare-protected pages.
- **Recommendation:** For any target site known to use Cloudflare WAF or Turnstile, a BaaS option is the only reliable path. See **Cost Comparison** section below for specific service pricing.

### Recommendation

**For JS-rendered public pages without Cloudflare protection:** Use **Playwright + `playwright-extra` stealth plugin** (Option A enhanced). This is a local, free solution that handles the majority of SPAs and non-protected sites. Does not require an API key. Add `playwright-extra` and `puppeteer-extra-plugin-stealth` alongside `playwright` to get to ~70–80% Cloudflare success on basic protection.

**For Cloudflare-protected public pages (primary recommendation for anti-bot bypass):** Use a cloud BaaS. **Browserbase** is the recommended first choice: native Playwright/Stagehand SDK, explicit Cloudflare bypass via its "Verified" tier, per-session billing that is cost-effective at low-to-moderate volume (free plan, then $99/month for 500 hours). **Bright Data Scraping Browser** is the alternative if per-GB billing is preferable or higher proxy rotation quality is needed ($8/GB PAYG). Both expose a standard Playwright API, so the same `browse.ts` module can target either endpoint.

**For authenticated content:** Use **Browser Use MCP** (Option C) if and when that use case materialises. The setup cost (two API keys, saved profiles) is non-trivial; don't add it speculatively. Document it as the recommended path in `SKILL.md` when a user asks.

**Revised priority order for browser automation implementation:**
1. Add `web_browse` backed by local Playwright + stealth plugin — handles the 80–90% case for unprotected SPAs at zero cost.
2. Add Browserbase as a cloud backend behind the same `web_browse` tool: when `BROWSERBASE_API_KEY` is set, route through Browserbase instead of local Chromium. This covers Cloudflare-protected pages without a separate tool.
3. Browser Use MCP for authenticated content only when a concrete use case requires it.

### What a `web_browse` tool would look like

```typescript
// Tool signature
{
  name: "web_browse",
  description:
    "Fetch a JavaScript-rendered page using a headless browser. " +
    "Use for SPAs and pages that require JS execution. Slower than web_fetch. " +
    "Falls back to web_fetch for plain HTML pages.",
  parameters: TypeObject({
    url: TypeString({ description: "URL to navigate to" }),
    maxChars: TypeOptional(TypeInteger({ description: "Max characters to extract, default 6000" })),
    waitFor: TypeOptional(TypeString({ description: "CSS selector to wait for before extracting, e.g. '#content'" })),
  })
}

// Workflow inside execute():
// 1. Launch playwright chromium (or reuse an existing browser instance)
// 2. page.goto(url, { waitUntil: "networkidle" })
// 3. If waitFor provided: page.waitForSelector(waitFor)
// 4. Extract via page.evaluate(() => document.body.innerText)
// 5. Run through extractTextFromHtml() or equivalent normalisation
// 6. Truncate to maxChars, return result
```

**Files affected:**
- New `src/extensions/websearch/browse.ts` — Playwright wrapper following the same `{ ok, value } | { ok, error }` pattern as `fetch.ts`.
- `src/extensions/websearch/tools.ts` — add `web_browse` tool registration.
- `src/extensions/websearch/websearch.ts` — no change needed (tools.ts handles registration).
- `package.json` — add `playwright` as a dependency.
- `skills/web-tools/SKILL.md` — document when to use `web_browse` vs `web_fetch`.

---

## Cost Comparison: JS Rendering + Browser Automation

| Service | Pricing Model | Free Tier | Cloudflare Bypass | JS Rendering | PDF | Auth Support | Integration |
|---|---|---|---|---|---|---|---|
| **Browserbase** | $0–$99/mo plans + $0.10–$0.12/hr overage | Yes (1 hr/mo) | Yes — explicit ("Verified" tier, headful browser + residential proxies) | Yes | No | Yes — 1Password credential injection, session state | Playwright/Puppeteer native, Stagehand SDK, REST |
| **Browser Use** | Per-minute browser session + per-GB bandwidth + 1.2× LLM token cost + 0.2× orchestration fee | Yes (credit-based) | Yes — advanced stealth cloud browsers | Yes | No | Yes — saved login profiles persist across sessions | MCP server, open-source Python SDK |
| **Bright Data Scraping Browser** | $5–$8/GB; PAYG $8/GB; $499/mo for 71 GB incl. | No (free trial available) | Yes — explicit (auto-unlocking, CAPTCHA solving, fingerprinting, human-like behavior) | Yes — headful GUI browser | No | Yes — session management, cookie injection | Playwright/Puppeteer/Selenium API-compatible, REST |
| **ScrapingBee** | Credit-based: 1 req = 1 credit; JS rendering = 5 credits; stealth mode = 75 credits; $49.99/250K cr, $99.99/1M cr | 1,000 free credits on signup | Partial — stealth mode exists but costs 75× a basic request; no explicit Turnstile bypass | Yes (default) | No | Cookie/session header injection | REST, Python/Node/Ruby/PHP SDKs |
| **Apify** | $39/mo (Starter) + $0.30/compute unit; actor-level pricing varies by marketplace actor | Yes — $5 credits/mo | Partial — depends on actor; residential proxies available separately | Yes — browser-based actors use full Chromium | Yes — some actors support PDF | Yes — session cookie injection | REST, Actor marketplace, Python/JS SDK |
| **Parallel Extract** | $0.001/request (per URL) | No — requires `PARALLEL_API_KEY` | Unknown — not advertised; likely ineffective against Cloudflare WAF | Yes — headless JS rendering | Yes — PDF → markdown | No — public pages only | REST, Python/JS SDK, MCP |
| **Playwright + stealth** | Free (open-source: `playwright-extra` + `puppeteer-extra-plugin-stealth`) | N/A | Partial — 60–80% on basic checks; fails Cloudflare Turnstile and behavioral analysis | Yes | No (separate `pdf-parse` needed) | Yes — `storageState.json` cookie injection | Local npm dependency, no cloud |
| **Crawl4AI** | Free (self-hosted Python) | N/A | Partial — needs CapSolver integration + proxy config for Cloudflare | Yes — Playwright-based | No | Yes — cookies, proxy headers | Python library, self-hosted |

### Cost Analysis for Typical Usage

Assumptions: 1–2 min average session, ~1 MB rendered page size, JS rendering enabled for all requests.

| Service | 100 req/mo | 1,000 req/mo | 10,000 req/mo |
|---|---|---|---|
| Browserbase | $0 (Free plan: 1 hr covers ~60 sessions; ~$0.20 overage for remainder) | $20/mo (Developer plan; 100 hrs included, ~17 hrs used) | $99/mo (Startup: 500 hrs incl.; ~167 hrs used at 1 min/session) |
| Browser Use | ~$0–2 (Free tier) | ~$10–50 (variable: session time + LLM tokens) | ~$100–500 (variable; depends heavily on task complexity and token usage) |
| Bright Data | ~$0.80 (0.1 GB × $8 PAYG) | ~$8 (1 GB × $8 PAYG) | ~$80 (10 GB × $8 PAYG) or $499/mo plan if volume spikes |
| ScrapingBee | $0 (500 credits < 1K free trial) | $49.99/mo (Freelance; 5K JS credits well within 250K allotment) | $99.99/mo (Startup; 50K JS credits well within 1M allotment) |
| Apify | $0 (Free plan; $5 credits covers light use) | ~$40/mo (Starter $39 + ~$1 compute) | ~$210/mo (Scale $199 + ~$10 compute) |
| Parallel Extract | $0.10 | $1.00 | $10.00 |
| Playwright + stealth | $0 | $0 | $0 (local) — or $20–50/mo if hosted on cloud VM |
| Crawl4AI | $0 | $0 | $0 (local) — or $20–50/mo if hosted on cloud VM |

**Key observations:**
- Parallel Extract is the cheapest paid option by a wide margin ($0.001/req), but does not handle Cloudflare-protected sites.
- For Cloudflare bypass at low volume (≤1K req/mo), Browserbase at $20/mo or Bright Data PAYG (~$8) are the most cost-effective cloud options.
- At 10K req/mo, Browserbase Startup ($99) and ScrapingBee Startup ($99.99) are roughly equivalent in monthly cost — Browserbase wins on Cloudflare bypass reliability; ScrapingBee is simpler to integrate (REST call, no WebSocket).
- Playwright + stealth is free but unreliable against Cloudflare: budget for BaaS fallback on any site you don't control.
- Browser Use costs are hard to bound without knowing LLM token consumption per task; suitable for complex multi-step workflows, not bulk single-page extraction.

### Cloudflare-Specific Notes

- **Explicit Cloudflare bypass advertised:** Browserbase (Verified tier), Bright Data Scraping Browser (auto-unlocking + human-like behavior), ScrapingBee (stealth mode — but 75× credit cost makes it expensive).
- **JS rendering only, no anti-bot bypass:** Parallel Extract (public/unprotected pages only), Apify (depends on actor configuration and proxy type).
- **Partial / community-reported bypass:** Playwright + `puppeteer-extra-plugin-stealth` (60–80% on basic Cloudflare; fails Turnstile), Crawl4AI (requires CapSolver + residential proxy pairing).
- **Cloudflare's own browser API** (`$0.09/hr` via Cloudflare Workers) is not viable here: it is intended for code running inside Cloudflare Workers, not for external agents scraping third-party sites.

### Revised Recommendation for Browser Automation

Given the Cloudflare constraint, the original recommendation ("use local Playwright as the primary option") is insufficient for production use on third-party sites.

**Recommended implementation path:**
1. **Local Playwright + stealth** as the base layer — handles SPAs and sites that don't actively block automation (~0 cost).
2. **Browserbase** as the cloud fallback layer — route through Browserbase when `BROWSERBASE_API_KEY` is set. Free plan covers prototyping; Startup ($99/mo) covers production workloads up to ~10K sessions/month.
3. **Bright Data Scraping Browser** as an alternative if per-GB pricing is preferable, or if higher-quality residential proxy rotation is needed.
4. **Parallel Extract** for the bulk of non-Cloudflare public pages — at $0.001/request it is 100× cheaper than any BaaS option and handles JS rendering + PDFs natively.

---

## Note on Environment Variable Propagation

The `web_search` tool reads `process.env.TAVILY_API_KEY` inside the `execute()` callback — at call time, not at extension registration time. This is the correct pattern: if env var propagation to the extension process was recently fixed, this code will pick up the variable correctly without any changes needed. Worker `worker-moeofy52` is performing an end-to-end verification of this propagation; that result should be checked before concluding `web_search` is fully operational in the multi-agent setup.
