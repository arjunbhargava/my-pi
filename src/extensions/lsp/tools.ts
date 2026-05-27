/**
 * Tool registration for the LSP extension.
 *
 * Takes a registrar callback, the registry, the resolver, and typebox constructors
 * as parameters. No direct imports from `@earendil-works/pi-coding-agent`.
 */

import type { ServerRegistry } from "./registry.js";
import type { SymbolResolver } from "./resolver.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's registerTool uses complex generic types from typebox
type ToolRegistrar = (def: any) => void;

/** Maximum number of results to emit before appending a truncation note. */
const MAX_RESULTS = 100;

/**
 * Register the 5 LSP tools: lsp_workspace_symbols, lsp_definition, lsp_references,
 * lsp_hover, and lsp_diagnostics.
 *
 * @param registry   - Active ServerRegistry for diagnostics buffer access.
 * @param resolver   - SymbolResolver for name-to-position queries.
 * @param register   - The `pi.registerTool` function.
 * @param TypeObject - `Type.Object` from typebox.
 * @param TypeString - `Type.String` from typebox.
 * @param TypeOptional - `Type.Optional` from typebox.
 */
export function registerLspTools(
  registry: ServerRegistry,
  resolver: SymbolResolver,
  register: ToolRegistrar,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typebox schema constructors
  TypeObject: (...args: any[]) => any,
  TypeString: (...args: any[]) => any,
  TypeOptional: (...args: any[]) => any,
): void {
  register({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description:
      "Search for symbols (functions, classes, methods, variables) across the entire workspace using the language server.",
    promptSnippet: "Search workspace symbols by name. Returns matching types, functions, classes, and variables.",
    promptGuidelines: [
      "Use lsp_workspace_symbols to find where a symbol is defined before reading files.",
      "Supports partial matches — search for class names, function names, or method names.",
    ],
    parameters: TypeObject({
      query: TypeString({ description: "Symbol name or partial name to search for" }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const result = await resolver.workspaceSymbols(params.query as string);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {}, isError: true };
      }
      const lines = result.value.map((s) => `${s.path}:${s.line}: ${s.kind} ${s.name}`);
      return {
        content: [{ type: "text", text: formatCompact(lines) || "No symbols found." }],
        details: { count: result.value.length },
      };
    },
  });

  register({
    name: "lsp_definition",
    label: "LSP Go to Definition",
    description: "Find the definition of a symbol using the language server.",
    promptSnippet: "Go to definition of a symbol. Pass symbol name like 'ClassName.method' or 'functionName'.",
    promptGuidelines: [
      "Use symbol names, not positions. The tool resolves names to locations internally.",
      "Use hint_path to disambiguate when the same symbol exists in multiple languages.",
    ],
    parameters: TypeObject({
      symbol: TypeString({ description: "Symbol name, e.g. 'MyClass', 'MyClass.method', 'functionName'" }),
      hint_path: TypeOptional(TypeString({ description: "File path hint to narrow the search to a specific language server" })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const hintPath = typeof params.hint_path === "string" ? params.hint_path : undefined;
      const result = await resolver.definition(params.symbol as string, hintPath);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {}, isError: true };
      }
      const lines = result.value.map((l) => `${l.path}:${l.line}: ${l.snippet}`);
      return {
        content: [{ type: "text", text: formatCompact(lines) || "No definition found." }],
        details: { count: result.value.length },
      };
    },
  });

  register({
    name: "lsp_references",
    label: "LSP Find References",
    description: "Find all references to a symbol across the workspace.",
    promptSnippet: "Find all references to a symbol across the workspace.",
    promptGuidelines: [
      "Use to understand usage patterns before refactoring.",
      "Pass the fully qualified name for methods: 'ClassName.method'.",
    ],
    parameters: TypeObject({
      symbol: TypeString({ description: "Symbol name, e.g. 'MyClass', 'MyClass.method', 'functionName'" }),
      hint_path: TypeOptional(TypeString({ description: "File path hint to narrow the search to a specific language server" })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const hintPath = typeof params.hint_path === "string" ? params.hint_path : undefined;
      const result = await resolver.references(params.symbol as string, hintPath);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {}, isError: true };
      }
      const lines = result.value.map((l) => `${l.path}:${l.line}: ${l.snippet}`);
      return {
        content: [{ type: "text", text: formatCompact(lines) || "No references found." }],
        details: { count: result.value.length },
      };
    },
  });

  register({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get type signature and documentation for a symbol from the language server.",
    promptSnippet: "Get type signature and documentation for a symbol.",
    promptGuidelines: [
      "Use to check function signatures and return types without reading the full file.",
    ],
    parameters: TypeObject({
      symbol: TypeString({ description: "Symbol name, e.g. 'MyClass', 'MyClass.method', 'functionName'" }),
      hint_path: TypeOptional(TypeString({ description: "File path hint to narrow the search to a specific language server" })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const hintPath = typeof params.hint_path === "string" ? params.hint_path : undefined;
      const result = await resolver.hover(params.symbol as string, hintPath);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }], details: {}, isError: true };
      }
      if (!result.value) {
        return { content: [{ type: "text", text: "No hover information found." }], details: {} };
      }
      const { type, docstring } = result.value;
      const text = docstring ? `Type: ${type}\nDocs: ${docstring}` : `Type: ${type}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  register({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Get compiler/linter diagnostics (errors, warnings) buffered from the language server for a file or the whole workspace.",
    promptSnippet: "Get compiler/linter diagnostics (errors, warnings) for a file or the whole workspace.",
    promptGuidelines: [
      "Diagnostics update automatically after edits. Call without path to see all current issues.",
      "Fix errors before moving on — they indicate real problems the compiler found.",
    ],
    parameters: TypeObject({
      path: TypeOptional(TypeString({ description: "File path to get diagnostics for. Omit to get all diagnostics." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const filePath = typeof params.path === "string" ? params.path : undefined;
      const diagnostics = collectDiagnostics(registry, filePath);
      if (diagnostics.length === 0) {
        return { content: [{ type: "text", text: "No diagnostics." }], details: { count: 0 } };
      }
      const lines = diagnostics.map((d) => `${d.severity} ${d.path}:${d.line}: ${d.message}`);
      return {
        content: [{ type: "text", text: formatCompact(lines) }],
        details: { count: diagnostics.length },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render pre-formatted lines as newline-separated text.
 * Truncates to MAX_RESULTS entries with a trailing note if exceeded.
 */
function formatCompact(lines: string[]): string {
  if (lines.length <= MAX_RESULTS) return lines.join("\n");
  const overflow = lines.length - MAX_RESULTS;
  return `${lines.slice(0, MAX_RESULTS).join("\n")}\n... and ${overflow} more`;
}

/**
 * Collect diagnostics from all active language server buffers.
 * If filePath is provided, returns only diagnostics for that file.
 */
function collectDiagnostics(registry: ServerRegistry, filePath?: string) {
  return registry.getActiveLanguages().flatMap((lang) => {
    const buffer = registry.getDiagnosticsBuffer(lang);
    if (!buffer) return [];
    return filePath ? buffer.getForFile(filePath) : buffer.getAll();
  });
}
