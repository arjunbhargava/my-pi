# browser_check — live-verification checklist

Live-verifies the `browser_check` tool (`src/extensions/browser/`) end to end
against a real headless Chromium and a real local static server. This is a
tester artifact, not a unit test: it exercises the actual tool code path
(`registerBrowserCheck` → `execute`) against real pixels and real page signals.

Status of the last run is recorded at the bottom under "Last live run".

## Prereqs

- `node` (verified with v24.14.1) and `python3` (verified with 3.12.7) on PATH.
- Dependencies installed in this worktree:
  ```
  npm install
  ```
  (installs `playwright-core`, `@earendil-works/*`, `tsx`, `sharp`.)
- A Chromium binary for Playwright:
  ```
  node node_modules/playwright-core/cli.js install --with-deps chromium
  ```
  On macOS `--with-deps` is effectively a no-op (no apt step); plain
  `... install chromium` works too. The smaller headless shell also works:
  ```
  node node_modules/playwright-core/cli.js install --only-shell chromium
  ```

No credentials, no external network beyond the one intentionally-failing
in-page fetch, no cost beyond the one-time ~150 MB Chromium download.

## Files

- `tests/e2e/browser-check-fixture.html` — the page under test. It deliberately
  emits one of every signal class on load:
  - visible content (blue header, green `#crop-target`, three responsive cards);
  - `console.error("FIXTURE_CONSOLE_ERROR: ...")`;
  - `console.warn("FIXTURE_CONSOLE_WARN: ...")`;
  - `fetch("/__fixture_missing_resource__.json")` → HTTP 404 (a failed request);
  - an asynchronous `throw new Error("FIXTURE_UNCAUGHT_EXCEPTION: ...")` (a
    `pageerror`).
- `tests/e2e/browser-check-driver.mts` — the driver. It builds the same wiring
  the extension entry point uses (`BrowserManager`, `SignalBuffer`, pi's
  `resizeImage`), captures the registered `browser_check` definition, serves the
  fixture with `python3 -m http.server`, and calls `execute` across all modes,
  asserting on the returned content array and details. Tears down the browser
  and the server unconditionally (even on failure).

## Run

Single command (starts and stops its own static server):

```
npx tsx tests/e2e/browser-check-driver.mts
```

Exit 0 = all checks passed; exit 1 = a check failed or the driver crashed.
Expected duration: ~3-5 s (dominated by the cold Chromium launch).
Override the port with `BC_PORT=<port>` if 8099 is taken.

The first viewport screenshot is written to `/tmp/browser-check-viewport.png`
for optional visual inspection (`qlmanage -p /tmp/browser-check-viewport.png`).

## What each step verifies

Mapped to the task's numbered flow:

- **Step 3 — one bundled result.** Call A (default viewport) returns exactly one
  image (non-empty base64, width ≤ 1500 px) AND text signals containing the
  console error, the console warning, the 404 failed request, and the uncaught
  exception. Call B (same URL again) drains clean — the signal text is
  "No console errors, warnings, failed requests, or exceptions since last
  check.", proving no stale signals carry over.
- **Step 4 — persistent browser.** Call A cold-launches (includes the Chromium
  launch + first navigation); Call B reuses the warm page and is materially
  faster. The driver asserts `warm < cold` and prints both timings.
- **Step 5 — responsive + selector.** Call C (`responsive: true`) returns two
  images labeled `390px` and `1440px`. Call D (`selector: "#crop-target"`)
  returns one image labeled `element:#crop-target`, cropped smaller than the
  1440 px viewport.
- **Step 6 — missing-browser path.** Verified separately by launching
  `BrowserManager.launch()` with no Chromium installed: it returns the
  actionable message containing `node node_modules/playwright-core/cli.js
  install` and the `--only-shell` alternative — not a raw stack trace. This can
  only be reproduced on a machine with no Chromium binary; where a browser is
  installed, the case is covered by the unit test (task aaf847f4) rather than
  re-run live.

## Last live run

Run on 2026-07-09, macOS (arm64), `node v24.14.1`, `python3 3.12.7`,
`playwright-core@1.60.0`, Chrome Headless Shell 148.0.7778.96 (chromium v1223).

- Step 6 (missing-browser) verified first, before installing Chromium:
  `launch()` returned the actionable install message (with `--only-shell`),
  `is a raw stack trace: false`.
- `npx tsx tests/e2e/browser-check-driver.mts` → **ALL PASS** (17/17), exit 0:
  - A: 1 image, `1440px` wide, signals text contained all four classes.
  - B: drained clean; `cold=2395ms warm=19ms` (warm ≈ 126x faster).
  - C: two images `390px, 1440px`.
  - D: one image `element:#crop-target`, `200x51`.
- Teardown re-queried and confirmed: no `chrome-headless-shell`/`chromium`
  process, no `http.server`, no listener on port 8099.
- Saved screenshot `/tmp/browser-check-viewport.png` (1440x900 PNG) rendered the
  fixture correctly (blue header, green crop target, three-column layout).
