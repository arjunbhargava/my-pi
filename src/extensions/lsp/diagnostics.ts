/**
 * Buffer for LSP `textDocument/publishDiagnostics` notifications.
 * Each `update` call replaces the complete set for that file (LSP semantics).
 * Tool implementations pull from the buffer on demand.
 */

import {
  DIAGNOSTIC_SEVERITY_MAP,
  type DiagnosticEntry,
} from "./types.js";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

export class DiagnosticsBuffer {
  private readonly store = new Map<string, DiagnosticEntry[]>();

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Called by the LSP client when a `textDocument/publishDiagnostics`
   * notification arrives. Replaces all diagnostics for the given URI.
   */
  update(uri: string, diagnostics: unknown[]): void {
    const relativePath = uriToRelativePath(uri, this.workspaceRoot);
    this.store.set(relativePath, diagnostics.map((d) => parseDiagnostic(d, relativePath)));
  }

  /**
   * Get buffered diagnostics for a specific file.
   *
   * Accepts any of: workspace-relative path (e.g. `src/foo.ts`), absolute
   * path under the workspace root, or relative-with-prefix forms like
   * `./src/foo.ts`. The input is normalized to the same workspace-relative
   * shape used as the storage key before lookup. Files outside the workspace
   * root fall back to absolute-path lookup, matching how `update` keys them.
   *
   * Returns an empty array if no diagnostics have been received for the file.
   */
  getForFile(filePath: string): DiagnosticEntry[] {
    return this.store.get(this.normalizeKey(filePath)) ?? [];
  }

  /** Get all buffered diagnostics across every file. */
  getAll(): DiagnosticEntry[] {
    const result: DiagnosticEntry[] = [];
    for (const entries of this.store.values()) {
      result.push(...entries);
    }
    return result;
  }

  /** Clear diagnostics for a specific file. Accepts the same path shapes as `getForFile`. */
  clearFile(filePath: string): void {
    this.store.delete(this.normalizeKey(filePath));
  }

  /** Clear all buffered diagnostics. */
  clearAll(): void {
    this.store.clear();
  }

  /** Number of files currently holding at least one diagnostic entry. */
  get fileCount(): number {
    return this.store.size;
  }

  /**
   * Normalize an input path to the storage key shape produced by `update`:
   *  - Resolve relative-with-prefix forms (`./foo.ts`, `foo.ts`) against the
   *    workspace root.
   *  - Strip the workspace-root prefix when present, yielding a forward-slash
   *    relative path.
   *  - Leave absolute paths outside the workspace root untouched, since
   *    `update` stores them under their full absolute path.
   */
  private normalizeKey(filePath: string): string {
    const absolute = isAbsolute(filePath)
      ? filePath
      : resolve(this.workspaceRoot, filePath);
    const rel = relative(this.workspaceRoot, absolute);
    if (rel === "" || rel.startsWith("..")) {
      // Outside the workspace root: match how `update` stores these.
      return absolute;
    }
    return rel;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `file://` scheme and the workspace root prefix from a URI,
 * returning a path relative to the workspace root.
 */
function uriToRelativePath(uri: string, workspaceRoot: string): string {
  const filePath = fileURLToPath(uri);
  const normalizedRoot = workspaceRoot.endsWith("/")
    ? workspaceRoot
    : `${workspaceRoot}/`;
  return filePath.startsWith(normalizedRoot)
    ? filePath.slice(normalizedRoot.length)
    : filePath;
}

/**
 * Parse a raw LSP Diagnostic object into a `DiagnosticEntry`.
 * Unknown severity values default to "hint".
 */
function parseDiagnostic(raw: unknown, relativePath: string): DiagnosticEntry {
  const d = raw as Record<string, unknown>;
  const severity =
    typeof d["severity"] === "number"
      ? (DIAGNOSTIC_SEVERITY_MAP[d["severity"]] ?? "hint")
      : "hint";

  const range = d["range"] as
    | { start?: { line: number } }
    | undefined;
  const startLine = range?.start?.line;
  const line = startLine !== undefined ? startLine + 1 : 0;
  const message =
    typeof d["message"] === "string" ? d["message"] : String(d["message"] ?? "");

  return { severity, path: relativePath, line, message };
}
