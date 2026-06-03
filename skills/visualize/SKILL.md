---
name: visualize
description: Render SVG charts and diagrams inline in the TUI as images. Use when a visual is clearer than ASCII art.
---

# Visualize

## Tools

### `visualize`

Renders SVG markup to a PNG and displays it inline in the interactive TUI. Conversion is handled by `sharp`.

Parameters:
- `kind` (required) — visualization kind. Currently only `"svg"` is supported.
- `content` (required) — complete, valid SVG markup with explicit `width` and `height` attributes. HTML is not supported.
- `title` (optional) — human-readable label for the visualization.

The most recently rendered visualization is retained for the `/visualize` command.

## Commands

### `/visualize`

Shows the most recent visualization in a full-screen overlay. Requires interactive mode; reports an error in non-interactive runs and an info notice when nothing has been rendered yet.

## Workflow

1. **Reach for `visualize` when an image beats ASCII.** Charts, diagrams, and geometric layouts are clearer as images than as text art.
2. **Emit complete SVG.** The `content` must be valid standalone SVG with explicit `width` and `height` — no surrounding HTML.
3. **Interactive only.** Image output renders in the TUI. In non-interactive contexts the tool still returns the render result text, but the image and `/visualize` overlay require an interactive session.
