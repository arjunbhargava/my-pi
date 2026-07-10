---
name: browser-check
description: Visual feedback loop for front-end work via the browser_check tool. Use when editing HTML/CSS/UI against a running dev server and you need to see what actually rendered.
---

# Browser Check

## What `browser_check` returns

One tool call, one result: screenshot(s) of the page **plus** every cheap text
signal accumulated since the last check — console errors and warnings, failed
network requests, and uncaught exceptions. Triage the text signals first, then
the pixels: a `Cannot read properties of undefined` in the console usually
explains a blank or broken page faster than staring at the screenshot.

The browser and page persist across calls. The first call launches Chromium
and navigates; later calls with the same `url` skip navigation and
re-screenshot the warm page.

## Parameters

- `url` (required) — page to check, typically a local dev-server URL.
- `fullPage` — capture the full scrollable page. Default false (viewport only).
- `selector` — CSS selector; crop the screenshot to that element.
- `responsive` — capture both 390px and 1440px viewports in one call. Default false.
- `compareToPrevious` — also include the previous screenshot from this session, labeled before/after. Default false.

## Loop discipline

1. **Batch, then look.** Make a coherent batch of visual edits, then call
   `browser_check` once. Screenshot-per-edit doubles turn count for no gain.
2. **Dev server + HMR, not rebuilds.** Run an HMR dev server (e.g. `vite dev`)
   and keep it running. The loop is: edit → HMR settles (~100–300ms) →
   `browser_check` with the same `url` against the warm page. Full rebuilds
   turn each iteration into 10–30s and kill the economics.
3. **Before/after when judging a change.** Set `compareToPrevious: true` after
   making a change — comparing the two screenshots is far more reliable for
   "did my change do what I intended, or regress something else" than
   re-reasoning about the new screenshot from scratch.
4. **Terminate on spec, not vibes.** End the loop with an explicit
   self-assessment: compare the screenshot against the original requirements
   and list unmet ones. Open-ended "make it better" churns indefinitely, and
   later iterations often regress earlier wins.

## What to capture

- **Viewport shot by default.** Use `fullPage: true` only when you need it —
  full-page shots of long pages get downscaled into illegibility.
- **`responsive: true` when layout across screen sizes matters.** Responsive
  bugs are the most common class a model can't predict from code, and the
  second viewport is nearly free in the same call.
- **`selector` crop for typography and fine detail.** A cropped element
  screenshot is far more information-dense than a full page.
- Screenshots are 1x device pixel ratio with width capped at ~1500px by
  design — do not expect retina detail; crop instead.

## What NOT to do

- **Do not use DOM dumps (accessibility tree, `outerHTML`) as the feedback
  signal.** Models predict layout from DOM badly — that is the whole reason
  for the visual loop. DOM access is only for finding selectors.
- **No pixel-diff thresholds** (Percy-style assertions) inside the loop — too
  brittle; judging "does this change look right" from the screenshots works better.
- **No separate critic model.** Critiquing your own screenshot works nearly as
  well and halves complexity.

## Headless Ubuntu over SSH

This is a first-class setup, not a degraded one. Run the dev server and the
browser co-located on the remote box; `browser_check` navigates to `localhost`
there. The screenshot reaches the model as image data regardless of whether
the terminal can render images over SSH — the inline TUI preview may not show,
but the model still sees the screenshot. No X server or port-forwarding is
needed for the tool itself.

One-time browser provisioning on a fresh box:

```
node node_modules/playwright-core/cli.js install --with-deps chromium
```

(or `--only-shell chromium` for the smaller headless-only build).
