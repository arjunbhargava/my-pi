/**
 * LSP protocol client wrapping JsonRpcTransport with lifecycle management,
 * document synchronization, and LSP request methods.
 *
 * One instance maps to one language server process. Call `initialize()` before
 * any other method and keep the instance alive across tool calls — cold-start
 * is expensive.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { JsonRpcTransport } from "./transport.js";
import {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  type ServerConfig,
  type DocumentState,
  type Result,
} from "./types.js";
import type { DiagnosticsBuffer } from "./diagnostics.js";

interface LspClientOptions {
  config: ServerConfig;
  workspaceRoot: string;
  diagnosticsBuffer: DiagnosticsBuffer;
}

export class LspClient {
  private transport: JsonRpcTransport | null = null;
  private initialized = false;
  private readonly documents = new Map<string, DocumentState>();

  constructor(private readonly options: LspClientOptions) {}

  /**
   * Spawn the server, exchange `initialize` / `initialized`, and register
   * the `textDocument/publishDiagnostics` notification handler.
   * Must be called once before any other method.
   */
  async initialize(): Promise<Result<void>> {
    if (this.initialized) {
      return { ok: false, error: "Client already initialized" };
    }

    const { config, workspaceRoot, diagnosticsBuffer } = this.options;
    const transport = new JsonRpcTransport({
      command: config.command,
      args: config.args,
      cwd: workspaceRoot,
    });

    transport.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
      const p = params as { uri: string; diagnostics: unknown[] };
      diagnosticsBuffer.update(p.uri, p.diagnostics ?? []);
    });

    transport.onRequest("workspace/configuration", (params: unknown) => {
      const p = params as { items?: Array<{ section?: string }> };
      return (p.items ?? []).map(() => ({}));
    });

    transport.onRequest("client/registerCapability", () => null);
    transport.onRequest("window/workDoneProgress/create", () => null);

    try {
      await transport.sendRequest(
        "initialize",
        {
          processId: process.pid,
          rootUri: pathToUri(workspaceRoot),
          workspaceFolders: [{ uri: pathToUri(workspaceRoot), name: basename(workspaceRoot) }],
          capabilities: {
            textDocument: {
              synchronization: { didOpen: true, didChange: true, didClose: true },
              hover: { contentFormat: ["plaintext"] },
              definition: { linkSupport: false },
              references: {},
              documentSymbol: {},
              publishDiagnostics: {},
            },
            workspace: {
              symbol: { dynamicRegistration: false },
              configuration: true,
              workspaceFolders: true,
            },
          },
        },
        DEFAULT_INITIALIZE_TIMEOUT_MS,
      );
    } catch (err) {
      transport.dispose();
      return {
        ok: false,
        error: `Initialize failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    transport.sendNotification("initialized", {});
    this.transport = transport;
    this.initialized = true;
    return { ok: true, value: undefined };
  }

  /**
   * Read the file from disk and send `textDocument/didOpen`.
   * Subsequent queries reflect on-disk content until `changeDocument` is called.
   */
  async openDocument(filePath: string): Promise<Result<void>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const uri = pathToUri(filePath);
    const state: DocumentState = {
      uri,
      languageId: this.options.config.languageId,
      version: 1,
      content,
    };
    this.documents.set(filePath, state);
    this.transport!.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: this.options.config.languageId, version: 1, text: content },
    });
    return { ok: true, value: undefined };
  }

  /**
   * Notify the server that file content changed (TextDocumentSyncKind.Full).
   * Calls `openDocument` first if the file has not been opened yet.
   */
  async changeDocument(filePath: string, content: string): Promise<Result<void>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };

    if (!this.documents.has(filePath)) {
      const openResult = await this.openDocument(filePath);
      if (!openResult.ok) return openResult;
    }

    const state = this.documents.get(filePath)!;
    state.version++;
    state.content = content;
    this.transport!.sendNotification("textDocument/didChange", {
      textDocument: { uri: state.uri, version: state.version },
      contentChanges: [{ text: content }],
    });
    return { ok: true, value: undefined };
  }

  /** Send `textDocument/didClose` and remove the document from tracking. */
  async closeDocument(filePath: string): Promise<Result<void>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };

    const state = this.documents.get(filePath);
    if (!state) return { ok: false, error: `Document not opened: ${filePath}` };

    this.transport!.sendNotification("textDocument/didClose", {
      textDocument: { uri: state.uri },
    });
    this.documents.delete(filePath);
    return { ok: true, value: undefined };
  }

  /** Send `workspace/symbol`. Returns raw LSP `SymbolInformation[]`. */
  async workspaceSymbols(query: string): Promise<Result<unknown[]>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };
    try {
      const result = await this.transport!.sendRequest("workspace/symbol", { query });
      return { ok: true, value: (result as unknown[]) ?? [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send `textDocument/definition` at the given 0-based position.
   * Returns raw LSP `Location | Location[] | LocationLink[]`.
   */
  async definition(filePath: string, line: number, character: number): Promise<Result<unknown>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };
    try {
      const result = await this.transport!.sendRequest("textDocument/definition", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
      });
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send `textDocument/references` at the given 0-based position.
   * Includes the declaration in results. Returns raw LSP `Location[]`.
   */
  async references(filePath: string, line: number, character: number): Promise<Result<unknown[]>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };
    try {
      const result = await this.transport!.sendRequest("textDocument/references", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
        context: { includeDeclaration: true },
      });
      return { ok: true, value: (result as unknown[]) ?? [] };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send `textDocument/hover` at the given 0-based position.
   * Returns raw LSP `Hover` response (or null if nothing to show).
   */
  async hover(filePath: string, line: number, character: number): Promise<Result<unknown>> {
    if (!this.isReady) return { ok: false, error: "Server not initialized" };
    try {
      const result = await this.transport!.sendRequest("textDocument/hover", {
        textDocument: { uri: pathToUri(filePath) },
        position: { line, character },
      });
      return { ok: true, value: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Graceful shutdown: `shutdown` request → `exit` notification → dispose.
   * Safe to call on an uninitialized client.
   */
  async shutdown(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.transport.sendRequest("shutdown", undefined);
    } catch {
      // Best-effort — server may already be gone.
    }
    this.transport.sendNotification("exit");
    this.transport.dispose();
    this.transport = null;
    this.initialized = false;
    this.documents.clear();
  }

  /** True when initialized and the underlying transport is still alive. */
  get isReady(): boolean {
    return this.initialized && this.transport !== null && this.transport.isAlive;
  }

  /** The LSP language identifier this client handles (e.g. `"typescript"`). */
  get languageId(): string {
    return this.options.config.languageId;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert an absolute filesystem path to a `file://` URI, percent-encoding special characters. */
export function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/** Convert a `file://` URI back to an absolute filesystem path, decoding percent-encoded characters. */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}
