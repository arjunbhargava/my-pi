# lavish-axi CLI Reference

Empirical findings from probing `npx -y lavish-axi` (v0.1.31) on 2026-06-25.
All output blocks are verbatim captures from this session unless labeled otherwise.

---

## Version and installation

```
$ npx -y lavish-axi --version
0.1.31
```

The tool is fetched on demand via `npx -y lavish-axi`. No global install is required.
Cached under `~/.npm/_npx/` after first fetch.

---

## Command inventory

The complete subcommand set is defined in the source as:

```
COMMANDS = { "open", "poll", "end", "stop", "server", "playbook", "design", "setup" }
```

`open` is the internal name for the `<html-file>` positional; users call it as
`lavish-axi <html-file>`. All other names map directly to CLI arguments.

---

## Subcommand: bare invocation / `--help`

`lavish-axi` (no args) and `lavish-axi --help` both emit usage guidance. The no-arg
form also includes `sessions: []` (or a list of open sessions when any exist).

```
$ npx -y lavish-axi --help
bin: ~/.npm/_npx/1be68cb99ce3a4fa/node_modules/.bin/lavish-axi
description: "Lavish Editor helps agents turn rich HTML artifacts into collaborative human review surfaces. Whenever you are about to give user a complex response that will be easier to understand via a rich / interactive page, consider using Lavish Editor. First generate an interactive HTML artifact according to user request, then run `lavish-axi <html-file>` so the user can visually review it, annotate elements or selected text, queue prompts, and send feedback back through `lavish-axi poll`."
visual_guidance[4]: "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance","Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose","Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view","Prevent horizontal overflow: design narrow layouts intentionally, use minmax(0, 1fr) and min-width: 0 for grid/flex children, and deliberately wrap or truncate long labels/status text"
playbooks[7]{id,use_when}:
  diagram,"Map relationships, flows, state, and architecture"
  table,Turn dense records into scan-friendly review surfaces
  comparison,"Show options, tradeoffs, and current vs target behavior"
  plan,Explain a product or technical plan before implementation
  code,"Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts"
  input,"Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact"
  slides,Create a deliberate presentation when slides are requested
help[9]: Run `lavish-axi <html-file>` to open or resume a Lavish Editor session,...
EXIT CODE: 0
```

Note: `-h` before the subcommand is rejected:

```
$ npx -y lavish-axi -h
error: Flags must come after the command
code: VALIDATION_ERROR
help[2]: "Run `lavish-axi <command> [args] [flags]`",Move `-h` after the command instead of before it
EXIT CODE: 2
```

---

## Subcommand: `lavish-axi <html-file>`

Opens or resumes a Lavish Editor session for an HTML artifact.

```
$ npx -y lavish-axi somefile.html --help
Usage: lavish-axi <html-file> [--no-open]

Open or resume a Lavish Editor review session for an HTML artifact. Use --no-open when you
need to ensure the server/session exists without opening another browser window.
EXIT CODE: 0
```

Flags:
- `--no-open` — start or resume the session without launching a browser window (useful headlessly)

Output on success (`--no-open` run against `/tmp/lavish-probe/test.html`):

```
session:
  file: /tmp/lavish-probe/test.html
  url: "http://127.0.0.1:4387/session/dcac07dbd017e727"
  status: opened
next_step: "Do not respond to the user just yet. Now you must run `lavish-axi poll /tmp/lavish-probe/test.html`. ..."
EXIT CODE: 0
```

Running the same command a second time on the same file returns the same session URL (`status: opened`),
confirming sessions resume rather than create a new one.

---

## Subcommand: `lavish-axi poll <html-file>`

Long-polls for user feedback. Stays silent until the user submits feedback or ends the session.

```
$ npx -y lavish-axi poll --help
Usage: lavish-axi poll <html-file> [--agent-reply "..."]

This command long-polls indefinitely for queued user prompts, then returns them to the agent.
It stays silent while it waits - that is normal, never kill it. Do not pass --timeout-ms during
normal agent use; it is for tests and debugging only. If your harness limits how long a foreground
command may run, run the poll as a background task and wait for it to finish; if it still gets
killed or times out, just re-run it - queued feedback is never lost. Use --agent-reply after
applying prior feedback to display your response in Lavish Editor before waiting again.
EXIT CODE: 0
```

Flags:
- `--agent-reply "<message>"` — displays the agent's reply in the existing browser chat before polling again
- `--timeout-ms <ms>` — test/debug escape hatch; omit in production agent use

### Poll protocol

**Timeout case** (no feedback before `--timeout-ms`):

```
session:
  file: /tmp/lavish-probe/test.html
  status: waiting
next_step: "No user feedback arrived before the optional timeout. Run `lavish-axi poll /tmp/lavish-probe/test.html` without --timeout-ms to wait indefinitely - queued feedback is never lost, so re-running the poll is always safe."
EXIT CODE: 0
```

Exit code: **0** on timeout.

**Feedback case** (a prompt was POST-ed to the server while poll was running):

```
session:
  file: /tmp/lavish-probe/test.html
  status: feedback
dom_snapshot: ""
prompts[1]{uid,prompt,selector,tag,text}:
  test-001,Make the heading blue,h1,element,Test
next_step: "Apply the requested changes to /tmp/lavish-probe/test.html. Do not respond to the user just yet. Now you must run `lavish-axi poll /tmp/lavish-probe/test.html --agent-reply \"<message for the user>\"` without --timeout-ms unless the user ended the session. ..."
EXIT CODE: 0
```

Exit code: **0** on feedback delivery.

**Ended-session case** (poll called after `lavish-axi end`):

```
session:
  file: /tmp/lavish-probe/test.html
  status: ended
EXIT CODE: 0
```

Exit code: **0**.

### Prompt payload fields

Each entry in `prompts[]` has these fields (from `normalizePrompt` in source):

| Field      | Type   | Notes                                                                      |
|------------|--------|----------------------------------------------------------------------------|
| `uid`      | string | Unique ID assigned by the browser chrome                                   |
| `prompt`   | string | The user's text message                                                    |
| `selector` | string | CSS selector of the annotated element, empty string if no element targeted |
| `tag`      | string | Annotation tag (e.g. `"element"`, `"text"`, `"text-range"`)               |
| `text`     | string | Inner text of the targeted element or selected text range (up to 240 chars)|

A `target` object may also be present for text-range annotations (source: `normalizeTarget`); its
schema is not fixed (it is `JSON.parse(JSON.stringify(target))`). Not observed in headless testing.

`dom_snapshot` is a string field — observed as `""` when no browser was attached during this session.
When a browser is connected, it contains a DOM snapshot of the artifact iframe at the time of submission (unverified headlessly).

### stderr during long poll

While waiting, `poll` writes to stderr (stdout is reserved for the final response):

```
[lavish-axi] Long-polling for user feedback on <file>. This stays silent until the user sends
feedback or ends the session - leave it running. If it gets killed or times out, re-run
`lavish-axi poll <file>` - queued feedback is never lost.
```

Periodic heartbeat every 15 s:

```
[lavish-axi] Still waiting for user feedback (Nm). Leave this running until the user acts.
```

---

## Subcommand: `lavish-axi end <html-file>`

Ends a session.

```
$ npx -y lavish-axi end --help
Usage: lavish-axi end <html-file>

End a Lavish Editor session.
EXIT CODE: 0
```

Output on success:

```
session:
  file: /tmp/lavish-probe/test.html
  status: ended
EXIT CODE: 0
```

---

## Subcommand: `lavish-axi stop`

Shuts down the background server.

```
$ npx -y lavish-axi stop --help
Usage: lavish-axi stop [--port <port>]

Shut down the background Lavish Editor server. The server also stops itself when no browser or poll
has been connected for a while (LAVISH_AXI_IDLE_TIMEOUT_MS, default 30m) and immediately when the
last session ends with nothing connected.
EXIT CODE: 0
```

Output on success:

```
server:
  status: stopped
  port: 4387
EXIT CODE: 0
```

Flags:
- `--port <port>` — target a server running on a non-default port

---

## Subcommand: `lavish-axi server`

Runs the local server directly (instead of having it auto-start on demand).

```
$ npx -y lavish-axi server --help
Usage: lavish-axi server [--port 4387] [--verbose]

Run the local Lavish Editor server. Pass --verbose (or set LAVISH_AXI_DEBUG=1) to log session and
watcher events to stderr. Detached server output is appended to ~/.lavish-axi/server.log, or
LAVISH_AXI_STATE_DIR/server.log when set, for startup and crash diagnostics.

LAVISH_AXI_HOST sets the bind address (default 127.0.0.1; a wildcard 0.0.0.0 or :: binds every
interface). Binding beyond loopback exposes an unauthenticated server that can read and serve
arbitrary local files to anything that can reach it, so only do so on a trusted network.
LAVISH_AXI_LINK_HOST sets the hostname written into generated session links (default: the bind
address, or loopback when bound to a wildcard). LAVISH_AXI_NO_OPEN=1 (or --no-open) suppresses
the local browser launch.
EXIT CODE: 0
```

Flags:
- `--port <port>` — default `4387`
- `--verbose` — log session and watcher events to stderr; also enabled by `LAVISH_AXI_DEBUG=1`

Environment variables:
- `LAVISH_AXI_HOST` — bind address, default `127.0.0.1`
- `LAVISH_AXI_LINK_HOST` — hostname in session URLs, default: bind address or loopback for wildcard
- `LAVISH_AXI_IDLE_TIMEOUT_MS` — idle self-shutdown timer, default `1800000` (30 min); `0` or `off` disables it
- `LAVISH_AXI_STATE_DIR` — overrides the `~/.lavish-axi/` state directory
- `LAVISH_AXI_NO_OPEN=1` — suppress browser launch (equivalent to `--no-open`)

---

## Subcommand: `lavish-axi playbook [id]`

Lists playbooks or shows detailed guidance for one.

```
$ npx -y lavish-axi playbook
playbooks[7]{id,use_when}:
  diagram,"Map relationships, flows, state, and architecture"
  table,Turn dense records into scan-friendly review surfaces
  comparison,"Show options, tradeoffs, and current vs target behavior"
  plan,Explain a product or technical plan before implementation
  code,"Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts"
  input,"Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact"
  slides,Create a deliberate presentation when slides are requested
help[2]: Run `lavish-axi playbook <playbook_id>` for focused artifact guidance,...
EXIT CODE: 0
```

Requesting an unknown ID returns an error:

```
error: "Unknown playbook: -h"
code: VALIDATION_ERROR
help[1]: "Run `lavish-axi playbook` to list known IDs: diagram, table, comparison, plan, code, input, slides"
EXIT CODE: 2
```

Sample detailed output (`lavish-axi playbook diagram`):

```
playbook:
  id: diagram
  use_when: "Map relationships, flows, state, and architecture"
  choose[3]: ...
  structure[3]: ...
  design_rules[3]: ...
  pitfalls[3]: ...
  lavish_notes[2]: ...
EXIT CODE: 0
```

---

## Subcommand: `lavish-axi design`

Emits the fallback CDN snippet and DaisyUI component reference for use when neither the user
nor the subject project provides a design system.

```
$ npx -y lavish-axi design
design:
  summary: "Use this Lavish CDN fallback only if (1) the user gave no design direction and
    (2) you already inspected the project the artifact is about ... and found no design system
    or style conventions to match. ..."
  cdn_snippet: "<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css\">\n<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css\">\n<script src=\"https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js\"></script>"
  cdn_urls:
    tailwind: "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js"
    daisyui: "https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css"
    daisyuiThemes: "https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css"
  versions:
    tailwind: 4.2.4
    daisyui: 5.5.19
  latest_docs: "https://daisyui.com/components/"
  ...
theme_usage[6]: "Default to `<html data-theme=\"luxury\">`...", ...
themes[35]: light,dark,cupcake,...,luxury,...
components:
  actions[6]: button,dropdown,fab,modal,swap,theme-controller
  data_display[18]: accordion,avatar,badge,card,...
  navigation[8]: breadcrumbs,dock,link,menu,navbar,pagination,steps,tabs
  feedback[7]: alert,loading,progress,radial-progress,skeleton,toast,tooltip
  data_input[14]: calendar,checkbox,fieldset,file-input,filter,label,radio,range,rating,select,input,textarea,toggle,validator
  layout[8]: divider,drawer,footer,hero,indicator,join,mask,stack
  mockup[4]: mockup-browser,mockup-code,mockup-phone,mockup-window
EXIT CODE: 0
```

Key design defaults (as of v0.1.31):
- Default theme: `luxury` (`<html data-theme="luxury">`)
- Tailwind: `@tailwindcss/browser@4.2.4` (browser runtime, not PostCSS)
- DaisyUI: `5.5.19`
- DaisyUI classes must not be used in `@apply` inside `<style type="text/tailwindcss">` — the browser
  runtime does not resolve them and aborts the compile, leaving the page unstyled.
- Artifacts use local copies of these assets (bundled in the package under `dist/design/`) when a
  session is active; CDN URLs are also provided for direct embedding.

---

## Subcommand: `lavish-axi setup hooks`

Installs or repairs `SessionStart` hooks for Claude Code, Codex, and OpenCode.

```
$ npx -y lavish-axi setup hooks
hooks:
  status: installed
  integrations: "Claude Code, Codex, OpenCode"
help[1]: Restart your agent session to receive lavish-axi ambient context
EXIT CODE: 0
```

The hook surfaces live open sessions, playbooks, and usage guidance at the start of each
agent session without requiring a skill load.

---

## Session identity

Sessions are keyed by the SHA-256 hash of the canonical (realpath) file path, truncated to
16 hex characters. Verified:

```js
crypto.createHash('sha256').update('/tmp/lavish-probe/test.html').digest('hex').slice(0, 16)
// → "dcac07dbd017e727"
```

The session URL produced by `lavish-axi /tmp/lavish-probe/test.html --no-open` was
`http://127.0.0.1:4387/session/dcac07dbd017e727` — matching the computed hash.

Implications:
- A path with a different realpath (e.g. a symlink) opens a different session.
- Any agent invocation passing the same absolute canonical path resumes the same session.
- No opaque session ID is needed; the file path is the session identity.

State is persisted under `~/.lavish-axi/` (or `LAVISH_AXI_STATE_DIR`). Sessions survive
server restarts: `poll` will still return queued feedback even if the server was killed
between the user submitting and the agent re-running `poll`.

---

## Output format (TOON)

All command output is TOON (Tool-Optimized Output Notation) — a YAML-like structured text format.
No JSON wrapper. Fields are emitted as `key: value` pairs; arrays use `key[n]: item,...` or
multi-line `  key,value` indentation. This is what the README refers to as "TOON output."

Exit codes observed:
- `0` on success (open, poll timeout, poll feedback, poll ended, end, stop, design, playbook, setup hooks)
- `2` on validation error (missing required arg, unknown playbook ID, flag before command)

---

## `layout_warnings` — not present in v0.1.31

The task description referenced a `layout_warnings` field (with fields `selector`, `kind`,
`overflowPx`, `viewportWidth`, `severity`). After searching both `cli.mjs` and the README:

- No such field appears in the source code.
- No such field appears in the README.
- The feedback payload captured in this session (`prompts[]{uid,prompt,selector,tag,text}`) does not include it.

**Conclusion:** `layout_warnings` is not part of the v0.1.31 CLI surface. It was not
observed and is not documented in any captured output. Label as **unverified / not present**.

---

## Human-annotation round-trip (unverified headlessly)

The human-facing annotation flow — clicking elements in the browser, selecting text ranges,
pressing "Send to Agent" — requires a real browser session. The `dom_snapshot` field in the
feedback response was observed as `""` in headless testing (no browser connected).

Behaviors not verified:
- Populated `dom_snapshot` content (shape of the DOM snapshot string)
- `target` object on text-range annotations (present in source; not triggered headlessly)
- Live reload behavior when the HTML file is edited while a session is open
- `data-lavish-action` and `window.lavish.queuePrompt()` JavaScript API behavior
- "Send & end session" combined action

---

## Reproduction

```sh
export PATH="/home/arjunbhargava/.nvm/versions/node/v22.22.2/bin:$PATH"

# 1. Version
npx -y lavish-axi --version

# 2. Help
npx -y lavish-axi --help
npx -y lavish-axi poll --help
npx -y lavish-axi end --help
npx -y lavish-axi stop --help
npx -y lavish-axi server --help
npx -y lavish-axi playbook
npx -y lavish-axi design

# 3. Open session (headless)
mkdir -p /tmp/lavish-probe
echo '<html><body><h1>Test</h1></body></html>' > /tmp/lavish-probe/test.html
npx -y lavish-axi /tmp/lavish-probe/test.html --no-open

# 4. Poll - timeout case
npx -y lavish-axi poll /tmp/lavish-probe/test.html --timeout-ms 3000

# 5. Poll - feedback case (inject via HTTP while poll runs)
SESSION_KEY=$(node -e "const c=require('crypto'); console.log(c.createHash('sha256').update('/tmp/lavish-probe/test.html').digest('hex').slice(0,16))")
npx -y lavish-axi poll /tmp/lavish-probe/test.html --timeout-ms 10000 &
sleep 1
curl -s -X POST "http://127.0.0.1:4387/api/${SESSION_KEY}/prompts" \
  -H "Content-Type: application/json" \
  -d '{"prompts":[{"uid":"test-001","prompt":"Make the heading blue","selector":"h1","tag":"element","text":"Test"}]}'
wait

# 6. End session
npx -y lavish-axi end /tmp/lavish-probe/test.html

# 7. Stop server
npx -y lavish-axi stop
```
