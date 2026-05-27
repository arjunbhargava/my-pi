# LSP Extension

Language Server Protocol integration for pi. Gives the agent structured code intelligence — symbol search, go-to-definition, find-references, hover, and live diagnostics — without reading and grep-ing through entire codebases.

## What it does

The extension spawns language servers as child processes communicating over stdio (JSON-RPC), manages their lifecycle across the session, and exposes five tools to the model:

| Tool | Purpose |
|------|---------|
| `lsp_workspace_symbols` | Search for symbols (functions, classes, variables) across the project |
| `lsp_definition` | Jump to where a symbol is defined |
| `lsp_references` | Find all usages of a symbol |
| `lsp_hover` | Get type signatures and documentation |
| `lsp_diagnostics` | Retrieve compiler/linter errors and warnings |

The model passes symbol names (e.g. `"MyClass.method"`), not file positions. The resolver layer translates names to positions via `workspace/symbol` before making the actual LSP call.

## Architecture

```
lsp.ts          Entry point. Registers tools, hooks session lifecycle.
                Only file that imports from @earendil-works/pi-coding-agent.

tools.ts        Tool definitions and result formatting.

resolver.ts     Symbol-name-to-position resolution. Retries during indexing.

registry.ts     One LspClient per language, spawned lazily. Pre-flight binary check.

bootstrap.ts    Project detection (tsconfig.json, pyproject.toml, etc.)
                and initial didOpen to prime the server index.

client.ts       LSP protocol client wrapping JsonRpcTransport. Handles
                initialize/shutdown, document sync, and LSP request methods.

transport.ts    Raw JSON-RPC over stdio. Content-Length framing, request
                correlation, notification dispatch.

diagnostics.ts  Buffers publishDiagnostics notifications for on-demand retrieval.

types.ts        Shared types and constants. No logic.
```

## Supported languages

| Language | Server binary | Install |
|----------|--------------|---------|
| TypeScript/JavaScript | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `npm install -g pyright` |
| C/C++ | `clangd` | OS package manager (`apt install clangd`, `brew install llvm`) |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

The extension checks for each binary before spawning. If a server is missing, the tool returns a clear error with install instructions rather than failing silently.

## How servers are spawned

Servers start lazily on first tool use. The sequence:

1. Model calls `lsp_workspace_symbols` (or any LSP tool)
2. `resolver.getClients()` checks for active servers
3. If none: `bootstrap.detectProjectLanguages()` scans for marker files (tsconfig.json, pyproject.toml, Cargo.toml, etc.)
4. `registry.getClientForLanguage()` triggers `spawnNewClient`:
   - Pre-flight: verify binary exists on PATH via `which`
   - Spawn child process, exchange `initialize` / `initialized`
   - Register `publishDiagnostics` notification handler
5. `bootstrap.bootstrapServer()` opens a source file (`didOpen`) so the server builds its project index
6. First `workspace/symbol` may return empty while indexing — the resolver retries with backoff (up to 19s total, early-exit on success)

Servers persist for the session lifetime and are shut down gracefully (`shutdown` request + `exit` notification) on `session_shutdown`.

## Document synchronization

When the agent edits or writes a file (detected via `tool_result` hook), the extension:

1. Sends `textDocument/didChange` with full content
2. Waits 500ms (debounced) for the server to emit `publishDiagnostics`
3. If errors are present, injects them into the conversation as a steer message

This gives the model immediate feedback on type errors without requiring an explicit `lsp_diagnostics` call.

## Configuration

No user-facing configuration yet. The extension auto-detects project type from marker files. To override the server binary path, set the environment variable before starting pi (not yet formalized as a config surface).

## Known limitations

- **Indexing latency**: Pyright needs 10–15s for medium projects (70+ files). The retry window covers this but the first tool call may be slow.
- **No incremental sync**: Document changes send full file content (`TextDocumentSyncKind.Full`). Fine for typical agent edits, suboptimal for very large files.
- **Single workspace root**: The extension uses the git repository root (or cwd) as the sole workspace folder. Monorepos with multiple tsconfig roots may not resolve cross-package symbols.
- **No progress reporting**: Servers that support `$/progress` don't have their tokens tracked. Readiness is detected by polling `workspace/symbol`.
