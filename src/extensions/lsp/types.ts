/**
 * Shared type definitions and constants for the LSP extension.
 * No logic — only type declarations, interfaces, and constant maps.
 */

export type { Result } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relative path to the LSP extension source directory. */
export const LSP_EXTENSION_DIR = "src/extensions/lsp";

/** Milliseconds to wait for a language server to finish initializing. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

/** Milliseconds to wait for an individual LSP request response. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Language identifiers supported by this extension. */
export const SUPPORTED_LANGUAGES = [
  "typescript",
  "python",
  "cpp",
  "rust",
] as const;

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

/** Configuration for spawning and routing a language server subprocess. */
export interface ServerConfig {
  /** Language identifier (matches LSP textDocument languageId). */
  languageId: string;
  /** File extensions this server handles (without dots): ["ts", "tsx", "js", "jsx"]. */
  fileExtensions: readonly string[];
  /** Command to spawn the server. */
  command: string;
  /** Arguments to pass to the command. */
  args: readonly string[];
  /** Optional env var name that overrides the command path. */
  pathEnvVar?: string;
  /** Whether the server communicates over stdio. */
  usesStdio: boolean;
}

/** Predefined server configurations, one per supported language. */
export const SERVER_CONFIGS: readonly ServerConfig[] = [
  {
    languageId: "typescript",
    fileExtensions: ["ts", "tsx", "js", "jsx"],
    command: "typescript-language-server",
    args: ["--stdio"],
    usesStdio: true,
  },
  {
    languageId: "python",
    fileExtensions: ["py", "pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    usesStdio: true,
  },
  {
    languageId: "cpp",
    fileExtensions: ["c", "cpp", "cc", "cxx", "h", "hpp"],
    command: "clangd",
    args: [],
    usesStdio: true,
  },
  {
    languageId: "rust",
    fileExtensions: ["rs"],
    command: "rust-analyzer",
    args: [],
    usesStdio: true,
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC message types
// ---------------------------------------------------------------------------

/** Base type for all JSON-RPC 2.0 messages. */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
}

/** A JSON-RPC request expecting a response. */
export interface JsonRpcRequest extends JsonRpcMessage {
  id: number;
  method: string;
  params?: unknown;
}

/** A JSON-RPC response to a prior request. */
export interface JsonRpcResponse extends JsonRpcMessage {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC notification (no response expected). */
export interface JsonRpcNotification extends JsonRpcMessage {
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Tool result types — what our tools return to the model
// ---------------------------------------------------------------------------

/** A symbol found by workspace symbol search. */
export interface SymbolEntry {
  /** Symbol name. */
  name: string;
  /** Human-readable kind: "function", "class", "method", "variable", etc. */
  kind: string;
  /** File path relative to the workspace root. */
  path: string;
  /** 1-based line number. */
  line: number;
}

/** A single location in the codebase (definition or reference). */
export interface LocationEntry {
  /** File path relative to the workspace root. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** One-line context from the file at this location. */
  snippet: string;
}

/** Hover information for a symbol: its type and documentation. */
export interface HoverResult {
  /** Type signature as reported by the language server. */
  type: string;
  /** Documentation string if available, empty string otherwise. */
  docstring: string;
}

/** A single diagnostic message from a language server. */
export interface DiagnosticEntry {
  /** Severity level. */
  severity: "error" | "warning" | "info" | "hint";
  /** File path relative to the workspace root. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** Diagnostic message text. */
  message: string;
}

// ---------------------------------------------------------------------------
// Internal LSP types
// ---------------------------------------------------------------------------

/** LSP SymbolKind value (raw integer from the protocol). */
export type LspSymbolKind = number;

/**
 * Maps LSP SymbolKind integers to human-readable strings.
 * Values defined by the LSP specification §3.16.
 */
export const SYMBOL_KIND_MAP: Record<number, string> = {
  1: "file",        2: "module",      3: "namespace",  4: "package",
  5: "class",       6: "method",      7: "property",   8: "field",
  9: "constructor", 10: "enum",       11: "interface",  12: "function",
  13: "variable",   14: "constant",   22: "enumMember", 23: "struct",
  24: "event",      25: "operator",   26: "typeParameter",
};

/**
 * Maps LSP DiagnosticSeverity integers to our severity string union.
 * Values defined by the LSP specification §3.16.
 */
export const DIAGNOSTIC_SEVERITY_MAP: Record<
  number,
  DiagnosticEntry["severity"]
> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** State tracked for each file opened with the language server. */
export interface DocumentState {
  /** File URI (e.g., `file:///abs/path/to/file.ts`). */
  uri: string;
  /** LSP language identifier (e.g., `"typescript"`). */
  languageId: string;
  /** Monotonically increasing version counter, incremented on each change. */
  version: number;
  /** Current file content as a string. */
  content: string;
}
