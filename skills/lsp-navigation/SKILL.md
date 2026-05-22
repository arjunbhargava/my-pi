---
name: lsp-navigation
description: Code navigation and understanding via language server. Use LSP tools instead of grep/rg when navigating code, finding definitions, checking types, or locating references.
---

# LSP Navigation

## Core Rule

**Prefer LSP tools over grep/rg for code navigation.** The language server has
semantic understanding of the code — it resolves symbols through imports, type
hierarchies, and module boundaries. Grep matches text patterns and returns noise.

## When to use LSP

| Task | Tool | Not this |
|------|------|----------|
| Find where a function/class/type is defined | `lsp_definition` | `rg "function foo"` |
| Find all callers or usages of a symbol | `lsp_references` | `rg "foo("` |
| Check a function's signature or return type | `lsp_hover` | Reading the source file |
| Find a symbol when you know part of the name | `lsp_workspace_symbols` | `rg` or `find` |
| Check for type errors after edits | `lsp_diagnostics` | `npx tsc --noEmit` |
| See all current compiler/linter warnings | `lsp_diagnostics` (no path) | Running the full build |

## When grep is still appropriate

- Searching for string literals, comments, log messages, or config values
- Finding patterns across non-code files (markdown, JSON, YAML)
- Regex searches where the target is not a symbol (URLs, TODOs, magic numbers)
- When the language server is not running or does not cover the file type

## Workflow

1. **Orienting in a codebase:** Start with `lsp_workspace_symbols` to find the
   relevant types and entry points. Follow up with `lsp_definition` to read
   implementations.

2. **Understanding a symbol:** Use `lsp_hover` for the type signature, then
   `lsp_references` to see how it's used across the project.

3. **Before refactoring:** Use `lsp_references` to find all usages of the symbol
   you plan to change. This catches re-exports, interface implementations, and
   indirect references that grep misses.

4. **After editing:** Call `lsp_diagnostics` on the changed file (or omit the
   path for workspace-wide) to catch type errors immediately, without running a
   full build.

## Tips

- Use dot notation for methods: `lsp_definition` with `"MyClass.method"` finds
  the method definition, not just the class.
- Use `hint_path` when the same symbol name exists in multiple languages or
  packages — it narrows the search to the relevant language server.
- `lsp_workspace_symbols` supports partial matches. Search `"Handler"` to find
  `RequestHandler`, `ErrorHandler`, etc.
- Diagnostics accumulate as you edit. Call periodically to catch regressions
  before they pile up.
