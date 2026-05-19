/**
 * Server lifecycle management and per-language routing.
 *
 * Maintains one LspClient per language, spawned lazily on first use.
 * All consumers go through ServerRegistry rather than creating clients directly.
 */

import { extname } from "node:path";
import { LspClient } from "./client.js";
import { DiagnosticsBuffer } from "./diagnostics.js";
import { SERVER_CONFIGS, type ServerConfig, type Result } from "./types.js";

/** Milliseconds to wait for each client's graceful shutdown before moving on. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export class ServerRegistry {
  private readonly clients = new Map<string, LspClient>();
  private readonly buffers = new Map<string, DiagnosticsBuffer>();

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Get (or lazily create) the LSP client for a given file path.
   * Returns an error if the file extension is not supported.
   */
  async getClientForFile(filePath: string): Promise<Result<LspClient>> {
    const config = this.getConfigForFile(filePath);
    if (!config) {
      return { ok: false, error: `No language server configured for: ${filePath}` };
    }
    return this.getOrSpawnClient(config);
  }

  /**
   * Get (or lazily create) the LSP client for a given language ID.
   * Returns an error if the language ID is not recognized.
   */
  async getClientForLanguage(languageId: string): Promise<Result<LspClient>> {
    const config = SERVER_CONFIGS.find((c) => c.languageId === languageId);
    if (!config) {
      return { ok: false, error: `Unsupported language: ${languageId}` };
    }
    return this.getOrSpawnClient(config);
  }

  /**
   * Ensure a file is opened in its language server. Reads from disk.
   * Returns an error if the file extension is unsupported.
   */
  async ensureDocumentOpen(filePath: string): Promise<Result<void>> {
    const clientResult = await this.getClientForFile(filePath);
    if (!clientResult.ok) return clientResult;
    return clientResult.value.openDocument(filePath);
  }

  /**
   * Notify the appropriate server that a file's content changed.
   * Returns an error if the file extension is unsupported.
   */
  async notifyChange(filePath: string, content: string): Promise<Result<void>> {
    const clientResult = await this.getClientForFile(filePath);
    if (!clientResult.ok) return clientResult;
    return clientResult.value.changeDocument(filePath, content);
  }

  /**
   * Shut down all active servers. Each shutdown has a 5 s timeout;
   * the underlying transport force-kills via SIGKILL if the server
   * does not exit after SIGTERM.
   */
  async disposeAll(): Promise<void> {
    const shutdowns = Array.from(this.clients.values()).map((client) =>
      Promise.race([
        client.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]),
    );
    await Promise.all(shutdowns);
    this.clients.clear();
    this.buffers.clear();
  }

  /** Language IDs for all currently active (spawned and ready) servers. */
  getActiveLanguages(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get the shared DiagnosticsBuffer for a language.
   * Returns undefined if no server has been spawned for that language yet.
   */
  getDiagnosticsBuffer(languageId: string): DiagnosticsBuffer | undefined {
    return this.buffers.get(languageId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Find the ServerConfig whose fileExtensions include this file's extension. */
  private getConfigForFile(filePath: string): ServerConfig | undefined {
    const ext = extname(filePath).replace(/^\./, "").toLowerCase();
    if (!ext) return undefined;
    return SERVER_CONFIGS.find((c) =>
      (c.fileExtensions as readonly string[]).includes(ext),
    );
  }

  /**
   * Return the existing ready client for config.languageId, or spawn a new one.
   * A stale (not-ready) client is shut down before re-spawning.
   * On failed initialization the registry remains clean (no partial entries).
   */
  private async getOrSpawnClient(config: ServerConfig): Promise<Result<LspClient>> {
    const existing = this.clients.get(config.languageId);
    if (existing) {
      if (existing.isReady) return { ok: true, value: existing };
      // Transport died — clean up before re-spawning.
      await existing.shutdown();
      this.clients.delete(config.languageId);
      this.buffers.delete(config.languageId);
    }

    const buffer = new DiagnosticsBuffer(this.workspaceRoot);
    const client = new LspClient({ config, workspaceRoot: this.workspaceRoot, diagnosticsBuffer: buffer });

    const initResult = await client.initialize();
    if (!initResult.ok) {
      return {
        ok: false,
        error: `Failed to start ${config.languageId} server: ${initResult.error}`,
      };
    }

    this.clients.set(config.languageId, client);
    this.buffers.set(config.languageId, buffer);
    return { ok: true, value: client };
  }
}
