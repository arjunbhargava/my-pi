# LSP Extension Review: Reliability and Adoption Diagnosis

## Why Agents Don't Use LSP Consistently

Three root causes combine to produce the "model silently falls back to grep" pattern.

### Root Cause 1: Empty success is indistinguishable from genuine negative results

Every resolver method — `workspaceSymbols`, `definition`, `references`, `hover` — returns
`{ ok: true, value: [] }` (or `null` for hover) under all of these conditions:

- No server is active (binary not installed, detection failed, no project marker found)
- Server is still indexing and hasn't yet built its symbol table
- `workspace/symbol` request timed out (10s default) during initial index sweep
- `findSymbolPosition` resolved to no candidates

From the tool surface, all of these look identical:

```
lsp_workspace_symbols → "No symbols found."
lsp_definition        → "No definition found."
```

The model has no signal to distinguish "server not started" from "this symbol doesn't exist."
It concludes LSP doesn't know about the symbol and falls back to grep. This is the primary
driver of inconsistent adoption — it is a systematic, silent failure, not an intermittent one.

**Code references:**
- `resolver.ts:57` — `workspaceSymbols` loops over `clients` (which may be `[]`) and returns
  `{ ok: true, value: results }` regardless of why results are empty.
- `resolver.ts:95` — `resolveLocations` returns `{ ok: true, value: [] }` at four distinct
  `if (!pos)`, `if (!cr.ok)`, `if (!raw.ok)` branches; no path propagates an error.
- `resolver.ts:238–260` — `getClients()` returns `[]` silently when no languages are detected
  or all spawns fail; callers loop over the empty array and return empty results.

### Root Cause 2: The indexing backoff doesn't fire when no bootstrap file is found

After spawning a server, `bootstrapServer()` in `bootstrap.ts:71` calls `findBootstrapFile()`.
If no matching source file is found in `src/` or the workspace root, the function returns
without calling `this.bootstrapTimestamps.set()`.

`shouldRetry()` in `bootstrap.ts:37` checks `bootstrapTimestamps`:

```typescript
return languageIds.some((id) => {
  const ts = this.bootstrapTimestamps.get(id);
  return ts !== undefined && (now - ts) < ServerBootstrap.RETRY_WINDOW_MS;
});
```

No timestamp → `shouldRetry()` returns `false` → the retry loop in `resolver.ts:64–76` never
executes → `workspaceSymbols` returns empty on the first call with no retry, even if the
server was just spawned and needs time to index.

This affects any project where `src/` has no TypeScript/Python/etc. files at depth ≤3, or
where the extension is running from a non-standard directory layout.

**Code references:**
- `bootstrap.ts:71–82` — `bootstrapServer` returns early without timestamp if file not found.
- `bootstrap.ts:37–42` — `shouldRetry` gate on `bootstrapTimestamps`.
- `resolver.ts:64–66` — `if (results.length === 0 && this.bootstrap.shouldRetry(...))` — the
  entire 19s backoff is unreachable when timestamps are absent.

### Root Cause 3: First `getClients()` call with no active servers returns only one server

`resolver.ts:246–260` (the branch for `activeLanguages.length === 0`):

```typescript
for (const languageId of detected) {
  const result = await this.registry.getClientForLanguage(languageId);
  if (result.ok) {
    await this.bootstrap.bootstrapServer(languageId, result.value);
    return [result.value];   // ← exits after first successful spawn
  }
}
```

In a TypeScript+Python project with both `tsconfig.json` and `pyproject.toml`, only the
TypeScript server spawns on the first tool call. Python queries return empty results until
a second call enters the `activeLanguages.length > 0` branch and bootstraps Python too.

The next call loops over `activeLanguages` (now `["typescript"]`) and bootstraps TS again
via the `await this.bootstrap.bootstrapServer(lang, result.value)` call — which is a no-op
due to the `bootstrapped.has()` guard — then returns only the TS client. Python still doesn't
get a server unless the caller provides a `hintPath` pointing to a `.py` file.

**Code reference:** `resolver.ts:258` — `return [result.value]` inside the multi-language
detection loop.

---

## Reliability Issues

### Issue 1: `workspace/symbol` timeout swallowed silently during indexing

`DEFAULT_REQUEST_TIMEOUT_MS = 10_000` (`types.ts:18`). On a large project (hundreds of
TypeScript files), the first `workspace/symbol` call can time out before the server finishes
indexing. The timeout rejects the transport promise with an error, but in the resolver:

```typescript
// resolver.ts:57-62
for (const client of clients) {
  const raw = await client.workspaceSymbols(query);
  if (!raw.ok) continue;   // ← timeout error silently discarded
  ...
}
```

The error is dropped with `continue`. Results stay empty. The retry loop in `resolver.ts:64`
may or may not fire (depends on bootstrap timestamps — see Root Cause 2). If it fires, each
retry has the same 10s timeout. For a project that needs 25s to index, the total potential
wait is: 5 retries × 10s each + 19s of backoff delays = up to ~69s, but most of that time
is in timeouts that look identical to "no results."

**Code references:**
- `types.ts:18` — `DEFAULT_REQUEST_TIMEOUT_MS = 10_000`
- `resolver.ts:57–63` — `if (!raw.ok) continue`

### Issue 2: `tool_result` diagnostic injection requires a pre-existing active server

`lsp.ts:41–52`:

```typescript
const hasActiveServer = registry.getActiveLanguages().some((lang) => {
  const config = SERVER_CONFIGS.find((c) => c.languageId === lang);
  return (config?.fileExtensions as readonly string[] | undefined)?.includes(ext) ?? false;
});
if (!hasActiveServer) return;
```

This guard correctly avoids spawning a server as a side-effect of an edit. But the consequence
is that agents which only use `edit`/`write` tools — and never call an LSP query tool — never
get diagnostic feedback injected into the conversation. The server is never spawned, so
`getActiveLanguages()` always returns `[]`, and `hasActiveServer` is always false.

An agent that writes a TypeScript file with a type error will not see any automatic diagnostic
unless it has previously called `lsp_workspace_symbols` or another LSP tool to trigger server
spawn.

**Code reference:** `lsp.ts:41–52` — `hasActiveServer` guard.

### Issue 3: `bootstrapServer` records timestamp only on file-found path

As described in Root Cause 2, `bootstrap.ts:71–82` skips `this.bootstrapTimestamps.set()`
when `findBootstrapFile()` returns null. This is a one-line omission — the timestamp should
be recorded regardless of whether a bootstrap file was found, since the server was still
spawned and is still indexing:

```typescript
// Current:
const bootstrapFile = await this.findBootstrapFile(config.fileExtensions);
if (bootstrapFile) {
  await client.openDocument(bootstrapFile);
  this.bootstrapped.add(languageId);
  this.bootstrapTimestamps.set(languageId, Date.now());
}

// Should be:
const bootstrapFile = await this.findBootstrapFile(config.fileExtensions);
this.bootstrapped.add(languageId);
this.bootstrapTimestamps.set(languageId, Date.now());
if (bootstrapFile) {
  await client.openDocument(bootstrapFile);
}
```

### Issue 4: Stale diagnostics buffer after server crash and respawn

When `getOrSpawnClient` detects a dead client (`!existing.isReady`), it calls
`this.buffers.delete(config.languageId)` before respawning (`registry.ts:132–134`). The
timeout callback in `lsp.ts:62–75` captures `capturedRegistry` (the registry object), not a
direct buffer reference. On each invocation it calls
`capturedRegistry.getDiagnosticsBuffer(lang)`, which reads from the live `buffers` map. If
the server crashed between the `notifyChange` call and the 500ms timer firing, the buffer for
that language is deleted and the callback returns no diagnostics — silently, with no indication
of the crash.

This is unlikely in practice (crashes during a 500ms window), but the model would see no
diagnostic feedback even though its edit may have introduced errors.

### Issue 5: `checkBinaryAvailable` blocks the event loop

`registry.ts:184`: `execFileSync("which", [command], { stdio: "pipe" })` is synchronous.
With 4 configured languages, a first tool call that detects and spawns all of them runs up to
4 blocking `execFileSync` calls. Each `which` call should complete in under 5ms on a local
filesystem, so this is not measurable in practice, but it is an architectural inconsistency
in an otherwise fully async module.

---

## Adoption Barriers

### Barrier 1: Tool descriptions don't list supported languages

`tools.ts` descriptions for `lsp_workspace_symbols`, `lsp_definition`, `lsp_references`, and
`lsp_hover` say nothing about which languages are supported. When a model tries these tools on
Go, Ruby, Java, Kotlin, or any other language, it receives "No symbols found." or "No
definition found." with no explanation. The model concludes LSP doesn't work for that symbol
and gives up.

Supported languages are TypeScript/JavaScript, Python, C/C++, and Rust (`types.ts:31–37`).
This should appear in every tool description.

### Barrier 2: No guidance to retry on empty results

The `promptGuidelines` for `lsp_workspace_symbols` are:

```
"Use lsp_workspace_symbols to find where a symbol is defined before reading files."
"Supports partial matches — search for class names, function names, or method names."
```

There is no instruction for "if results are empty on first use, retry — the server may still
be indexing." Without this, a model that gets "No symbols found." treats it as definitive and
falls back to grep or reads files directly. A single additional guideline covering the transient
empty-result case would materially improve adoption on cold sessions.

### Barrier 3: No readiness signal before first tool use

There is no way for the model to know whether a language server is running, indexing, or not
yet started. The model has no tool to ask "what LSP servers are active?" before issuing a
symbol query. A `lsp_status` tool (or a readiness note injected at session start) would let
the model know when servers are warm and reduce speculative retries.

The `session_start` handler in `lsp.ts:23–39` initializes the registry and resolver but does
not spawn any server — that happens lazily on first tool use. There is no steer message at
session start to inform the model that LSP tools are available and which languages are
supported.

### Barrier 4: `lsp_diagnostics` returns nothing until the server is warm and a file has been edited

The diagnostics buffer (`diagnostics.ts`) only contains entries that arrived via
`textDocument/publishDiagnostics` notifications. The server sends these notifications after
receiving `textDocument/didChange` or `textDocument/didOpen`. If the agent calls
`lsp_diagnostics` without having previously edited a file (or called another LSP tool that
triggered `openDocument`), the buffer is empty even on a project with many pre-existing
errors.

The `promptGuidelines` for `lsp_diagnostics` say:
> "Diagnostics update automatically after edits."

This is true, but omits that diagnostics are absent before the first edit. A model that calls
`lsp_diagnostics` at the start of a session to assess project health will get "No diagnostics."
and may skip checking again after edits.

### Barrier 5: LSP tests excluded from `scripts/test-unit.sh`

All 5 LSP test files exist but none are in `test-unit.sh`. The consequence is that
regressions in the LSP extension go undetected in normal test runs. Three of the five test
files are pure unit tests or spawn non-LSP processes and could run unconditionally:

| Test file | Can run without real LSP server? |
|---|---|
| `lsp-diagnostics.test.ts` | Yes — pure buffer logic, no subprocess |
| `lsp-client.test.ts` | Yes — guard tests; one test spawns `nonexistent-lsp-server` which just fails fast |
| `lsp-transport.test.ts` | Yes — spawns `cat` and `true`, not LSP servers |
| `lsp-resolver.test.ts` | Yes — all "no active server" paths, no spawn |
| `lsp-registry.test.ts` | Mostly yes; one test (`concurrent getOrSpawnClient`) attempts to spawn `typescript-language-server` but guards on the result |

At minimum, `lsp-diagnostics`, `lsp-transport`, `lsp-client` (guard tests only), and
`lsp-resolver` should be added to `test-unit.sh`.

---

## Recommendations (Ranked)

### 1. Surface "server not ready" explicitly rather than returning empty success (highest leverage)

In `resolver.ts`, when `getClients()` returns an empty array, return an error result instead
of looping over an empty array:

```typescript
async workspaceSymbols(query: string, hintPath?: string): Promise<Result<SymbolEntry[]>> {
  const clients = await this.getClients(hintPath);
  if (clients.length === 0) {
    return {
      ok: false,
      error:
        "No language server is active. Supported languages: TypeScript/JavaScript, Python, C/C++, Rust. " +
        "Ensure the server binary is installed and a project marker file exists " +
        "(tsconfig.json, pyproject.toml, Cargo.toml, compile_commands.json).",
    };
  }
  ...
}
```

Similarly in `resolveLocations` and `hover`, propagate the client-fetch error rather than
silently returning `{ ok: true, value: [] }`. The tool surface already distinguishes
`isError: true` from a successful empty result — use it.

### 2. Fix the bootstrap timestamp gap in `bootstrap.ts`

Record `bootstrapTimestamps` before the `if (bootstrapFile)` check so `shouldRetry()` fires
even when no bootstrap file is found:

```typescript
// bootstrap.ts:71–82
this.bootstrapped.add(languageId);
this.bootstrapTimestamps.set(languageId, Date.now());
const bootstrapFile = await this.findBootstrapFile(config.fileExtensions);
if (bootstrapFile) {
  await client.openDocument(bootstrapFile);
}
```

One-line-order change; unblocks the entire indexing backoff for projects without `src/`.

### 3. Remove early return from `getClients()` to spawn all detected languages

`resolver.ts:246–260`: change `return [result.value]` to accumulate all detected clients:

```typescript
const spawnedClients: LspClient[] = [];
for (const languageId of detected) {
  const result = await this.registry.getClientForLanguage(languageId);
  if (result.ok) {
    await this.bootstrap.bootstrapServer(languageId, result.value);
    spawnedClients.push(result.value);
  }
}
return spawnedClients;
```

This ensures all detected languages are available on the first tool call in a multi-language
project.

### 4. Add supported-language list and retry guidance to tool descriptions

In `tools.ts`, extend the descriptions and guidelines:

- Add to `lsp_workspace_symbols` description: "Supports TypeScript/JavaScript, Python, C/C++, and Rust. Returns empty for other languages."
- Add to `promptGuidelines` for all symbol tools: "If results are empty on the first call in a session, the server may still be indexing. Retry the same query after a brief pause."
- Add a note that `lsp_diagnostics` returns no entries until the server has received at least one document via an LSP tool call or a file edit.

### 5. Add `lsp_status` tool reporting server readiness

A lightweight tool that returns active languages, bootstrap state, and whether any server is
still within the indexing retry window:

```
lsp_status → "Active: typescript (indexed), python (indexing, 8s elapsed)"
           → "No servers active. Supported: typescript, python, cpp, rust."
```

This gives the model a reliable signal before issuing symbol queries, eliminating the
guess-and-retry loop.

### 6. Inject a steer message at `session_start` advertising LSP availability

After `registry` and `resolver` are initialized, send a steer message listing the active
extension and the supported languages. This primes the model to prefer LSP tools before
grep:

```typescript
pi.sendMessage(
  {
    customType: "lsp_ready",
    content:
      "[LSP] Language server tools are available. " +
      "Supported languages: TypeScript/JavaScript, Python, C/C++, Rust. " +
      "Servers spawn on first use.",
    display: false,
  },
  { deliverAs: "steer" },
);
```

### 7. Raise `DEFAULT_REQUEST_TIMEOUT_MS` for the initial indexing period

10s is appropriate for steady-state queries but too tight for the first `workspace/symbol`
call during indexing on large projects. Consider using `DEFAULT_INITIALIZE_TIMEOUT_MS`
(30s) for the workspace/symbol requests that occur within the `shouldRetry` window, and
`DEFAULT_REQUEST_TIMEOUT_MS` thereafter. This prevents timeout-induced empty results from
confounding the retry backoff.

### 8. Add LSP unit tests to `scripts/test-unit.sh`

Add at minimum these four files, which have no real-server dependency:

```bash
echo "--- lsp-diagnostics ---"
npx tsx "$PROJECT_DIR/tests/lsp-diagnostics.test.ts"

echo "--- lsp-transport ---"
npx tsx "$PROJECT_DIR/tests/lsp-transport.test.ts"

echo "--- lsp-client (guard tests) ---"
npx tsx "$PROJECT_DIR/tests/lsp-client.test.ts"

echo "--- lsp-resolver ---"
npx tsx "$PROJECT_DIR/tests/lsp-resolver.test.ts"
```

`lsp-registry.test.ts` can be added with a note that the `concurrent getOrSpawnClient` test
may attempt a real spawn; it guards on the result so it passes whether or not
`typescript-language-server` is installed.

---

## Summary Table

| Failure scenario | Code location | Frequency | Impact |
|---|---|---|---|
| Empty success masks server not ready | `resolver.ts:57–76`, `resolver.ts:95–104` | Every cold session | High — model gives up on LSP |
| Bootstrap timestamp not set when no file found | `bootstrap.ts:71–82` | Any non-standard layout | High — disables 19s backoff |
| Only first detected language spawned | `resolver.ts:258` | Multi-language projects | Medium — Python/Rust queries empty |
| `workspace/symbol` timeout swallowed | `resolver.ts:57–63`, `types.ts:18` | Large projects, first call | Medium — false empty result |
| No server spawned by edit-only agents | `lsp.ts:41–52` | Agents that only edit | Medium — no diagnostic injection |
| Supported languages not in tool descriptions | `tools.ts` | Every unsupported language | Medium — model gives up silently |
| LSP tests absent from test-unit.sh | `scripts/test-unit.sh` | Every CI run | Low-medium — regressions invisible |
