/**
 * Symbol-first resolution layer for LSP queries.
 *
 * Models pass symbol names like "MyClass.method". This module resolves them
 * to file positions via workspace/symbol before making the real LSP call,
 * eliminating the need for callers to supply accurate line/column coordinates.
 */

import { readFile } from "node:fs/promises";
import { uriToPath } from "./client.js";
import type { ServerRegistry } from "./registry.js";
import type { LspClient } from "./client.js";
import {
  SYMBOL_KIND_MAP,
  type Result,
  type SymbolEntry,
  type LocationEntry,
  type HoverResult,
} from "./types.js";
import { ServerBootstrap } from "./bootstrap.js";

/** Backoff delays (ms) between workspace/symbol retry attempts after bootstrap. Total max wait: ~7.5 s. */
const INDEXING_BACKOFF_MS = [500, 1000, 2000, 4000] as const;

/** Resolved file position for a symbol (0-based, matching LSP protocol). */
interface SymbolPosition {
  filePath: string;
  line: number;
  character: number;
}

type NormalizedLocation = { uri: string; range: { start: { line: number; character: number } } };

export class SymbolResolver {
  private readonly bootstrap: ServerBootstrap;

  constructor(
    private readonly registry: ServerRegistry,
    private readonly workspaceRoot: string,
    bootstrap?: ServerBootstrap,
  ) {
    this.bootstrap = bootstrap ?? new ServerBootstrap(workspaceRoot);
  }

  /**
   * Search workspace symbols by query string.
   * Queries only the hintPath language server when provided and supported;
   * otherwise queries all active servers.
   *
   * On first use after bootstrap, retries with backoff until the server
   * finishes indexing (returns non-empty results or timeout expires).
   */
  async workspaceSymbols(query: string, hintPath?: string): Promise<Result<SymbolEntry[]>> {
    const clients = await this.getClients(hintPath);
    const results: SymbolEntry[] = [];
    for (const client of clients) {
      const raw = await client.workspaceSymbols(query);
      if (!raw.ok) continue;
      for (const sym of raw.value) {
        const entry = symbolToEntry(sym, this.workspaceRoot);
        if (entry) results.push(entry);
      }
    }

    // Server may still be indexing after bootstrap — retry with backoff.
    if (results.length === 0 && this.bootstrap.consumeBootstrappedFlag()) {
      for (const delay of INDEXING_BACKOFF_MS) {
        await new Promise((r) => setTimeout(r, delay));
        for (const client of clients) {
          const raw = await client.workspaceSymbols(query);
          if (!raw.ok) continue;
          for (const sym of raw.value) {
            const entry = symbolToEntry(sym, this.workspaceRoot);
            if (entry) results.push(entry);
          }
        }
        if (results.length > 0) break;
      }
    }

    return { ok: true, value: results };
  }

  /**
   * Resolve a symbol name to its definition location(s).
   * Returns an empty array if the symbol cannot be found.
   */
  async definition(symbol: string, hintPath?: string): Promise<Result<LocationEntry[]>> {
    return this.resolveLocations(symbol, hintPath, (c, f, l, ch) => c.definition(f, l, ch));
  }

  /** Find all references to a symbol. Returns an empty array if the symbol cannot be found. */
  async references(symbol: string, hintPath?: string): Promise<Result<LocationEntry[]>> {
    return this.resolveLocations(symbol, hintPath, (c, f, l, ch) => c.references(f, l, ch));
  }

  /** Get hover info (type + docs) for a symbol. Returns null if not found. */
  async hover(symbol: string, hintPath?: string): Promise<Result<HoverResult | null>> {
    const pos = await this.findSymbolPosition(symbol, hintPath);
    if (!pos) return { ok: true, value: null };
    await this.registry.ensureDocumentOpen(pos.filePath);
    const clientResult = await this.registry.getClientForFile(pos.filePath);
    if (!clientResult.ok) return { ok: true, value: null };
    const raw = await clientResult.value.hover(pos.filePath, pos.line, pos.character);
    if (!raw.ok) return { ok: true, value: null };
    return { ok: true, value: parseHoverResponse(raw.value) };
  }

  /**
   * Shared implementation for definition and references — both resolve a symbol
   * position then call the given LSP method.
   */
  private async resolveLocations(
    symbol: string,
    hintPath: string | undefined,
    call: (c: LspClient, f: string, l: number, ch: number) => Promise<Result<unknown>>,
  ): Promise<Result<LocationEntry[]>> {
    const pos = await this.findSymbolPosition(symbol, hintPath);
    if (!pos) return { ok: true, value: [] };
    await this.registry.ensureDocumentOpen(pos.filePath);
    const cr = await this.registry.getClientForFile(pos.filePath);
    if (!cr.ok) return { ok: true, value: [] };
    const raw = await call(cr.value, pos.filePath, pos.line, pos.character);
    if (!raw.ok) return { ok: true, value: [] };
    const entries = await Promise.all(
      normalizeLocations(raw.value).map((loc) => locationToEntry(loc, this.workspaceRoot)),
    );
    return { ok: true, value: entries.filter((e): e is LocationEntry => e !== null) };
  }

  /**
   * Resolve a dotted symbol name to a file position via workspace/symbol.
   *
   * Tries the full name first; if empty and the symbol has a dot, falls back to
   * searching by the member name. Filters by containerName when available, or
   * by co-location in the same file as the container symbol.
   *
   * The returned character offset is adjusted to point at the symbol name itself
   * (not the start of the declaration line), which is required for hover/definition.
   */
  private async findSymbolPosition(symbol: string, hintPath?: string): Promise<SymbolPosition | null> {
    const { container, member } = parseDottedSymbol(symbol);
    const clients = await this.getClients(hintPath);
    let candidates: unknown[] = [];

    for (const client of clients) {
      const raw = await client.workspaceSymbols(symbol);
      if (raw.ok) candidates.push(...raw.value);
    }

    // Fallback for dotted names: search by member and filter by container.
    if (candidates.length === 0 && container !== null) {
      // Find the container's file so we can match by co-location.
      const containerFile = await this.findContainerFile(container, clients);

      for (const client of clients) {
        const raw = await client.workspaceSymbols(member);
        if (!raw.ok) continue;
        for (const sym of raw.value) {
          const s = sym as Record<string, unknown>;
          const cn = typeof s["containerName"] === "string" ? s["containerName"] : null;
          if (cn === container || cn?.endsWith(`.${container}`)) {
            candidates.push(sym);
            continue;
          }
          // Accept if containerName is absent but symbol is in the same file as container.
          if (cn === null && containerFile) {
            const loc = s["location"] as NormalizedLocation | undefined;
            if (loc?.uri && uriToPath(loc.uri) === containerFile) {
              candidates.push(sym);
            }
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    const best = pickBestMatch(candidates, member, hintPath);
    if (!best) return null;

    const s = best as Record<string, unknown>;
    const loc = s["location"] as NormalizedLocation | undefined;
    if (!loc?.uri) return null;

    const filePath = uriToPath(loc.uri);
    const line = loc.range.start.line;
    const name = typeof s["name"] === "string" ? s["name"] : member;

    // Adjust character offset to point at the symbol name within the line.
    const character = await this.findNameOffsetInLine(filePath, line, name, loc.range.start.character);
    return { filePath, line, character };
  }

  /**
   * Find the file where a container symbol (class/interface) is defined.
   * Returns the absolute file path or null.
   */
  private async findContainerFile(container: string, clients: LspClient[]): Promise<string | null> {
    for (const client of clients) {
      const raw = await client.workspaceSymbols(container);
      if (!raw.ok) continue;
      for (const sym of raw.value) {
        const s = sym as Record<string, unknown>;
        if (s["name"] === container) {
          const loc = s["location"] as NormalizedLocation | undefined;
          if (loc?.uri) return uriToPath(loc.uri);
        }
      }
    }
    return null;
  }

  /**
   * Find the character offset of a symbol name within a source line.
   * Falls back to the range start character if the name isn't found.
   */
  private async findNameOffsetInLine(
    filePath: string,
    line: number,
    name: string,
    fallback: number,
  ): Promise<number> {
    const lineText = await readLineFromFile(filePath, line);
    if (!lineText) return fallback;
    // Use word-boundary matching to avoid partial matches.
    const regex = new RegExp(`\\b${escapeRegex(name)}\\b`);
    const match = regex.exec(lineText);
    return match ? match.index : fallback;
  }

  /**
   * Return clients to query. If hintPath resolves to a supported language,
   * returns only that server. Otherwise returns all active servers.
   *
   * When no servers are active and no hintPath is provided, detects the
   * project type from marker files in the workspace root, spawns the
   * appropriate server, and opens a bootstrap file so the server creates
   * a project context (required by tsserver for workspace/symbol).
   */
  private async getClients(hintPath?: string): Promise<LspClient[]> {
    if (hintPath) {
      const result = await this.registry.getClientForFile(hintPath);
      if (result.ok) {
        await this.bootstrap.ensureProjectBootstrapped(result.value, hintPath);
        return [result.value];
      }
    }

    const activeLanguages = this.registry.getActiveLanguages();

    // If no servers are active, detect project type and spawn.
    if (activeLanguages.length === 0) {
      const detected = await this.bootstrap.detectProjectLanguages();
      for (const languageId of detected) {
        const result = await this.registry.getClientForLanguage(languageId);
        if (result.ok) {
          await this.bootstrap.bootstrapServer(languageId, result.value);
          return [result.value];
        }
      }
      return [];
    }

    const clients: LspClient[] = [];
    for (const lang of activeLanguages) {
      const result = await this.registry.getClientForLanguage(lang);
      if (result.ok) {
        await this.bootstrap.bootstrapServer(lang, result.value);
        clients.push(result.value);
      }
    }
    return clients;
  }
}

/** Read a single line (0-based) from a file. Returns "" on any error. */
async function readLineFromFile(filePath: string, line: number): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split("\n")[line] ?? "";
  } catch {
    return "";
  }
}

/** Convert a normalized LSP Location to a LocationEntry with a one-line snippet. */
async function locationToEntry(location: NormalizedLocation, workspaceRoot: string): Promise<LocationEntry | null> {
  if (!location.uri) return null;
  const filePath = uriToPath(location.uri);
  const line0 = location.range.start.line;
  const snippet = (await readLineFromFile(filePath, line0)).trim();
  const relativePath = filePath.startsWith(`${workspaceRoot}/`)
    ? filePath.slice(workspaceRoot.length + 1)
    : filePath;
  return { path: relativePath, line: line0 + 1, snippet };
}

/**
 * Normalize the raw LSP definition result to a flat Location array.
 * Handles: null, single Location, Location[], LocationLink[].
 */
function normalizeLocations(raw: unknown): NormalizedLocation[] {
  if (!raw) return [];
  type LocationLink = { targetUri: string; targetSelectionRange: NormalizedLocation["range"] };
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        const l = item as Record<string, unknown>;
        if (typeof l["targetUri"] === "string") {
          const link = item as LocationLink;
          return { uri: link.targetUri, range: link.targetSelectionRange };
        }
        return item as NormalizedLocation;
      })
      .filter((item) => typeof item.uri === "string");
  }
  const l = raw as Record<string, unknown>;
  return typeof l["uri"] === "string" ? [raw as NormalizedLocation] : [];
}

/** Convert a raw LSP SymbolInformation to a SymbolEntry. Returns null if required fields are absent. */
function symbolToEntry(sym: unknown, workspaceRoot: string): SymbolEntry | null {
  const s = sym as Record<string, unknown>;
  const name = typeof s["name"] === "string" ? s["name"] : null;
  if (!name) return null;
  const kind = typeof s["kind"] === "number" ? (SYMBOL_KIND_MAP[s["kind"]] ?? "unknown") : "unknown";
  const loc = s["location"] as { uri: string; range: { start: { line: number } } } | undefined;
  if (!loc?.uri) return null;
  const filePath = uriToPath(loc.uri);
  const relativePath = filePath.startsWith(`${workspaceRoot}/`)
    ? filePath.slice(workspaceRoot.length + 1)
    : filePath;
  return { name, kind, path: relativePath, line: loc.range.start.line + 1 };
}

/**
 * Extract a HoverResult from a raw LSP Hover response.
 * Handles MarkupContent, MarkedString, and arrays thereof.
 * Returns null if the response is empty or unparseable.
 */
function parseHoverResponse(hover: unknown): HoverResult | null {
  if (!hover) return null;
  const h = hover as Record<string, unknown>;
  const contents = h["contents"];
  if (!contents) return null;

  let text = "";
  if (typeof contents === "string") {
    text = contents;
  } else if (Array.isArray(contents)) {
    text = contents
      .map((c) => {
        if (typeof c === "string") return c;
        const v = (c as Record<string, unknown>)["value"];
        return typeof v === "string" ? v : "";
      })
      .join("\n")
      .trim();
  } else if (typeof contents === "object" && "value" in (contents as object)) {
    text = (contents as { value: string }).value;
  }

  // Strip markdown code fences: ```language ... ```
  const stripped = text.replace(/```[a-z]*\n?/g, "").trim();
  const lines = stripped.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  return { type: lines[0].trim(), docstring: lines.slice(1).join("\n").trim() };
}

/** Split "Container.member" into parts. container is null for plain names. */
function parseDottedSymbol(symbol: string): { container: string | null; member: string } {
  const dotIndex = symbol.lastIndexOf(".");
  if (dotIndex === -1) return { container: null, member: symbol };
  return { container: symbol.slice(0, dotIndex), member: symbol.slice(dotIndex + 1) };
}

/** Score and pick the best workspace/symbol candidate: exact name +2, prefix +1, same file +10. */
function pickBestMatch(candidates: unknown[], member: string, hintPath?: string): unknown | null {
  let best: unknown = null;
  let bestScore = -1;
  for (const sym of candidates) {
    const s = sym as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"] : "";
    const loc = s["location"] as { uri?: string } | undefined;
    const filePath = loc?.uri ? uriToPath(loc.uri) : "";
    let score = 0;
    if (name === member) score += 2;
    else if (name.startsWith(member)) score += 1;
    if (hintPath && filePath === hintPath) score += 10;
    if (score > bestScore) { bestScore = score; best = sym; }
  }
  return best;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
