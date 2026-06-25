# Design Tooling Proposal

Proposed path to add a **visual/UI designer** to the agent roster and the supporting
tooling. Built from a design discussion (2026-06-25). Output of the designer is
Figma-adjacent artifacts — HTML/CSS, SVG, art, and style guidelines — **not** production
code.

This doc is a plan for review. Each phase is scoped so it can be dispatched as agent-team
tasks. Nothing here is built yet.

---

## 1. Problem and goal

Add a designer role that proposes visual directions, takes human feedback interactively,
and emits reviewable artifacts. Two questions drove the design:

1. Do we need Figma-specific tooling (an MCP bridge or a "figma" toolkit extension)?
2. How should the designer's "design system" be developed, and how does an agent reuse it?

The conclusions below answer both. The short version: **no Figma integration; code-first
artifacts; an interactive worker modeled on `tester`; a design system built on the W3C
Design Tokens standard, referenced by a thin skill.**

---

## 2. Decisions reached (with reasoning)

### D1. No Figma integration — the agent produces code-first artifacts

Grounded in Figma's current API surface:

- **`.fig` is closed and cloud-only.** It cannot be authored on disk.
- **REST API** (`api.figma.com`) is read-only for document content (reads JSON, exports
  PNG/SVG, manages comments/variables/webhooks). It cannot create or modify nodes.
- **Plugin API** has full read+write but runs *inside the Figma editor* with a logged-in
  user — not headless, not scriptable from pi.
- **Dev Mode MCP server** (`mcp.figma.com/mcp`) is design→code oriented; only allowlisted
  IDE clients in the Figma MCP Catalog (Claude Code, Cursor, VS Code, Codex, Gemini CLI)
  can connect. The allowlist matches on the **client app, not the model** — the remote
  server rejects non-listed clients at dynamic client registration (same situation as
  opencode). The **local desktop** server (`127.0.0.1:3845`) is a plain SSE/HTTP endpoint
  arbitrary clients can reach, but requires the Figma desktop app running + a paid
  full/dev seat, and is design→code, not authoring.

Two further blockers specific to us:

- **pi ships no MCP client** ("It intentionally does not include built-in MCP" —
  pi `docs/usage.md`). We would have to build MCP-client support before any Figma question
  applies. MCP is also against pi's ethos: if a capability is a file or a CLI, you register
  a tool or read the file — you don't add a protocol/daemon boundary.
- Every Figma write path is **design→code** (code/live-UI → editable Figma frame), the
  opposite of "produce design artifacts."

**Therefore:** the designer emits HTML/CSS + SVG + a markdown style guide + design-token
data. These are authorable, reviewable in-repo, and renderable via the existing `visualize`
tool and/or a browser. A Figma *read* integration (REST API wrapped as a pi tool — not MCP)
is only worth revisiting later if we want agents to *consume* existing Figma files; out of
scope here.

### D2. The designer is an interactive worker modeled on `tester`

We already have a human-in-the-loop worker: `agents/workers/tester.md`. Its loop is:
worker writes an artifact → announces a **handoff** (tmux attach command + what it needs) →
human attaches and provides input / visually confirms → explicit **skip path** (`DEFERRED`
mode) when the human is unavailable → records human replies as signal.

The designer reuses this exact control flow with two substitutions:

- "visually confirm a rendered output" → **open the proposed directions in a browser**;
- "paste credentials" → **pick a direction + state what to change**, typed in the tmux
  window.

This means the interactive designer fits the existing team/worker model — it does **not**
need a special main-session role or new infrastructure.

### D3. Reuse is filesystem reuse, not a service integration

Distinction: design-asset reuse (component lives as a Figma node → needs a live service)
vs. code-asset reuse (component lives as files → just read/import). We choose the latter.
The "design framework" is files in the repo (tokens + component catalog + guidelines), and
the designer reuses components the way `implementer` reuses code — read, grep, compose,
render to check.

### D4. The skill is a playbook, not the design system

The design system is a standalone, versioned code/data artifact. The skill only encodes
*conventions and governance* and points at where the artifact lives. Putting token values
or components inside a `SKILL.md` is the anti-pattern (no build step, no source of truth,
instant drift).

### D5. The design system is built on the W3C Design Tokens standard

- **Format:** W3C Design Tokens Community Group (DTCG) format, first stable version
  **2025.10** (Candidate Recommendation, Oct 2025): `$value`, `$type`, dot-notation aliases
  like `{color.brand.primary}`.
- **Architecture:** three tiers — primitive/reference (raw values) → semantic/system
  (intent, aliasing primitives) → component (component-scoped). Components reference
  semantic tokens, never primitives, never hardcoded values.
- **Transform:** Style Dictionary (v4+ has first-class DTCG support; note 2025.10 not yet
  fully supported — WIP in v5) compiles token JSON → CSS custom properties / other targets.
- **Components:** adopt, don't hand-roll — especially accessibility-critical components.
  Base on Radix/shadcn-ui or reference mature systems (Material 3, USWDS, Polaris, Carbon,
  Primer).
- **Taste/guidelines:** encoded as prompt/skill instructions (reference: Vercel "Web Design
  Guidelines" / "Frontend Design" skills), not as data.

**Best practice scales with need.** Starting with a full token pipeline before shipping a
screen is over-engineering. Start with the shadcn/Tailwind shortcut (Tailwind config *is* a
semantic token layer) + a `GUIDELINES.md`; graduate to DTCG + Style Dictionary only when a
second consumer (another platform/tool) appears — that is exactly the problem the spec
solves.

### D6. The feedback-loop tool: adopt before building

`lavish-axi` (github.com/kunchenguid/lavish-axi) is the on-point existing tool for the loop
layer: agent writes `artifact.html` → `npx lavish-axi <file>` opens a local browser UI →
human annotates elements/text ranges, sends chat → `lavish-axi poll` long-polls and returns
feedback. Local-only, zero cloud, distributed as a skill + on-demand CLI. It carries surplus
for our use (TOON output, long-polling protocol, layout audits, multi-harness hooks), but a
pi agent can call it today via `bash` with no build. We adopt before building a native
equivalent.

---

## 3. Architecture: two orthogonal layers

| Layer | Responsibility | Lives as |
| --- | --- | --- |
| **Feedback loop** | how the human sees and reacts to proposed directions | tmux text (v0) → `lavish-axi` bolt-on (v1) → optional native pi extension (v2) |
| **Taste / raw materials** | how the agent makes it look good before feedback | designer system prompt + `design-system` skill + token/component artifacts |

These are independent: the loop can advance without the design system maturing, and vice
versa.

---

## 4. Phased path forward

### Phase 0 — Working interactive designer, zero new infrastructure

**Concept.** A designer worker that writes N HTML/SVG directions to disk, opens them in a
browser, and takes feedback as text in its tmux window — structurally identical to `tester`.

**Deliverables.**
- `agents/workers/designer.md` — modeled on `tester.md`: handoff + skip path + structured
  report format. Tools: `read, write, edit, bash, grep, find, web_search, web_fetch,
  web_browse, visualize`. Model: a vision-capable default (e.g. the Claude model used by
  `tester`/`researcher`). No LSP.
- `skills/design-system/SKILL.md` (smallest-viable) — points at the artifact location,
  states the no-hardcoded-values rule, the naming convention, the render-and-critique loop,
  and a pointer to the taste guidelines.
- `design-system/GUIDELINES.md` — the taste layer (spacing rhythm, hierarchy, contrast,
  restraint), seeded from public references.
- Artifact convention: directions written to a gitignored dir (e.g. `.pi/design/<id>/
  option-*/`) + a gallery `index.html`; a chosen direction is promoted into the repo on
  "accept."

**Scope.** S (< 1 day). No code in `src/`. Pure agent-definition + skill + docs.

**Open decisions.** Number of directions per round; what each direction must contain
(tokens used, the HTML, one-line rationale); where promoted artifacts land.

### Phase 1 — Richer feedback via `lavish-axi` bolt-on

**Concept.** If typed feedback is too coarse, the designer skill optionally shells out to
`npx -y lavish-axi <file>` for point-and-click annotation, polling for results.

**Deliverables.**
- Extend `skills/design-system/SKILL.md` (or a new `skills/design-review/SKILL.md`) with the
  `lavish-axi` invocation/poll workflow and when to use it.
- Evaluation note: is the annotation UX worth the external npx dependency and its protocol
  surface? Record the verdict.

**Scope.** S (< 1 day), mostly evaluation.

**Dependency.** `npx` available; network for first fetch.

### Phase 2 — Native pi design-preview extension (only if Phase 1's surface is too heavy)

**Concept.** A trimmed reimplementation of `lavish-axi`'s core, integrated with pi's session
lifecycle and `ctx.ui` instead of an external CLI. Justified only by integration
cleanliness, not capability (Phase 1 already covers capability).

**Architecture.**
- A pi extension under `src/extensions/design/` registering a `present_designs` tool and/or
  a `/design` command.
- Start a **localhost-only** (`127.0.0.1`), ephemeral-port HTTP server in `session_start`
  (never in the factory — see pi `docs/extensions.md` "Long-lived resources and shutdown").
- Tear it down in an **idempotent `session_shutdown`** handler (verified: pi emits this on
  quit, fork, and session switch) so the server cannot leak past the session.
- Serve a gallery of the agent's HTML directions; accept annotate→POST feedback the agent
  reads; capture the human's pick via `ctx.ui.select` for the coarse case.
- Single-instance guard; never bind `0.0.0.0`.
- Follow my-pi standards: imports from `@earendil-works/pi-coding-agent` only in the entry
  point; `Result` types for expected failures; module under 300 lines or split.

**Scope.** M (2–4 days).

**Decision gate.** Build only after Phase 1 shows lavish-axi's surface is genuinely too
heavy for the workflow.

### Phase 3 — Graduate the design system to a token pipeline (only when a second consumer appears)

**Concept.** Promote the shadcn/Tailwind shortcut to a DTCG + Style Dictionary pipeline.

**Deliverables.**
- `design-system/tokens/{primitive,semantic,component}.tokens.json` in DTCG 2025.10 format.
- Style Dictionary config + build producing `tokens.css` (and other targets as needed).
  Verify DTCG 2025.10 support in the installed Style Dictionary version; fall back to its
  supported format if v5 isn't out.
- Update `skills/design-system/SKILL.md` to reference the token files and the build command.

**Scope.** M (1–2 days).

**Decision gate.** Do not build until a real second consumer (another platform or tool)
exists; otherwise it is premature.

---

## 5. Suggested dispatch shape (for an agent team)

Phase 0 is one cohesive unit and the right first dispatch:

1. **Task A — `designer.md`.** Author the worker definition modeled on `tester.md`. Acceptance:
   frontmatter valid against the agents-extension parser (`name`, `tools`, `model`);
   handoff + skip path + report format present; no production-code responsibilities.
2. **Task B — `design-system` skill + `GUIDELINES.md`.** Smallest-viable skill pointing at a
   shadcn/Tailwind-style token layer; governance rules; render-and-critique loop. Acceptance:
   skill discoverable; contains no token *values*; cites the taste references.
3. **Task C — artifact + gitignore convention.** Define `.pi/design/<id>/` layout, gallery
   `index.html` template, `.gitignore` entry, and the promote-on-accept step.

Phase 1 (`lavish-axi` evaluation) is a separate, later dispatch. Phases 2–3 are gated and
should not be dispatched until their decision gates are met.

---

## 6. Risks and open questions

- **Interactive worker ergonomics.** The `tester` handoff assumes the human can attach to a
  tmux window. Confirm the designer's browser-open step works from inside a worker's tmux
  context (headless display, `xdg-open`/`open` availability).
- **Artifact promotion policy.** Whether chosen directions are committed, and where, is
  unresolved (Phase 0 open decision).
- **Taste ceiling.** No tool supplies visual judgment; a vision-capable model partially
  substitutes for a designer's eye but is weaker. This is the real limiting factor and no
  phase closes it.
- **lavish-axi dependency.** External, npx-fetched, with its own protocol. Phase 1 must
  explicitly decide whether that coupling is acceptable.

---

## 7. References

- Figma Plugin API (read+write, in-editor only) — developers.figma.com/docs/plugins
- Figma REST API (read-only for content) — developers.figma.com
- Figma MCP server + catalog/allowlist — developers.figma.com/docs/figma-mcp-server,
  figma.com/mcp-catalog; Scalekit "Figma MCP vs API"
- pi extensions lifecycle (`session_start` / `session_shutdown`; no built-in MCP) —
  pi `docs/extensions.md`, `docs/usage.md`
- W3C Design Tokens spec 2025.10 (first stable) — w3.org/community/design-tokens,
  designtokens.org/TR/2025.10
- Three-tier tokens (reference/system/component) — Material Design 3,
  m3.material.io/foundations/design-tokens
- Style Dictionary DTCG support — styledictionary.com/info/dtcg
- `lavish-axi` — github.com/kunchenguid/lavish-axi
- Existing interactive-worker pattern — `agents/workers/tester.md`
</content>
