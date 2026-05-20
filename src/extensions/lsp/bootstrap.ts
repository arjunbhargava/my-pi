/**
 * Server bootstrap logic for LSP: project language detection and initial
 * document-open calls that prime tsserver / other servers to index the workspace.
 */

import { access, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { SERVER_CONFIGS } from "./types.js";
import type { LspClient } from "./client.js";

/** Map of project marker files to the language they indicate. */
const PROJECT_MARKERS: Array<{ file: string; languageId: string }> = [
  { file: "tsconfig.json", languageId: "typescript" },
  { file: "jsconfig.json", languageId: "typescript" },
  { file: "pyproject.toml", languageId: "python" },
  { file: "setup.py", languageId: "python" },
  { file: "Cargo.toml", languageId: "rust" },
  { file: "compile_commands.json", languageId: "cpp" },
  { file: ".clangd", languageId: "cpp" },
];

export class ServerBootstrap {
  private readonly bootstrapped = new Set<string>();
  /** Language IDs that were recently bootstrapped and haven't had their retry window yet. */
  private readonly recentlyBootstrapped = new Set<string>();

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Returns true and clears the recently-bootstrapped flags for the given languages
   * if any were bootstrapped since the last consume for that language.
   * Other languages' flags are untouched — each gets its own retry window.
   */
  consumeBootstrappedFlag(languageIds: string[]): boolean {
    const matching = languageIds.filter((id) => this.recentlyBootstrapped.has(id));
    if (matching.length === 0) return false;
    for (const id of matching) this.recentlyBootstrapped.delete(id);
    return true;
  }

  /**
   * Detect which languages the workspace supports by checking for
   * marker files (tsconfig.json, pyproject.toml, Cargo.toml, etc.).
   * Returns language IDs for which a server config exists.
   */
  async detectProjectLanguages(): Promise<string[]> {
    const detected: string[] = [];
    const seen = new Set<string>();
    for (const marker of PROJECT_MARKERS) {
      if (seen.has(marker.languageId)) continue;
      try {
        await access(join(this.workspaceRoot, marker.file));
        const hasConfig = SERVER_CONFIGS.some((c) => c.languageId === marker.languageId);
        if (hasConfig) {
          detected.push(marker.languageId);
          seen.add(marker.languageId);
        }
      } catch {
        // Marker not present — skip.
      }
    }
    return detected;
  }

  /**
   * Open a bootstrap file for the given language so the server creates a
   * project context. tsserver requires at least one textDocument/didOpen
   * before workspace/symbol works.
   */
  async bootstrapServer(languageId: string, client: LspClient): Promise<void> {
    if (this.bootstrapped.has(languageId)) return;
    const config = SERVER_CONFIGS.find((c) => c.languageId === languageId);
    if (!config) return;

    const bootstrapFile = await this.findBootstrapFile(config.fileExtensions);
    if (bootstrapFile) {
      await client.openDocument(bootstrapFile);
      this.bootstrapped.add(languageId);
      this.recentlyBootstrapped.add(languageId);
    }
  }

  /**
   * Ensure a client has been bootstrapped via the given hint path.
   */
  async ensureProjectBootstrapped(client: LspClient, filePath: string): Promise<void> {
    if (this.bootstrapped.has(client.languageId)) return;
    await client.openDocument(filePath);
    this.bootstrapped.add(client.languageId);
    this.recentlyBootstrapped.add(client.languageId);
  }

  /**
   * Find a source file in the workspace matching one of the given extensions.
   * Searches src/ recursively (up to 3 levels), then falls back to the workspace root.
   */
  private async findBootstrapFile(extensions: readonly string[]): Promise<string | null> {
    const extSet = new Set(extensions.map((e) => `.${e}`));

    const searchDir = async (dir: string, depth: number): Promise<string | null> => {
      if (depth > 3) return null;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && extSet.has(extname(entry.name).toLowerCase())) {
            return join(dir, entry.name);
          }
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            const found = await searchDir(join(dir, entry.name), depth + 1);
            if (found) return found;
          }
        }
      } catch {
        // Directory doesn't exist or not readable.
      }
      return null;
    };

    const srcDir = join(this.workspaceRoot, "src");
    const fromSrc = await searchDir(srcDir, 0);
    if (fromSrc) return fromSrc;
    return searchDir(this.workspaceRoot, 0);
  }
}
