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

/** Resolved file position for a symbol (0-based, matching LSP protocol). */
interface SymbolPosition {
  filePath: string;
  line: number;
  character: number;
}

type NormalizedLocation = { uri: string; range: { start: { line: number; character: number } } };

export class SymbolResolver {
  constructor(
    private readonly registry: ServerRegistry,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Search workspace symbols by query string.
   * Queries only the hintPath language server when provided and supported;
   * otherwise queries all active servers.
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
   * searching by the member name and filtering results by containerName.
   * Picks the best match (same-file > exact name > prefix > first result).
   */
  private async findSymbolPosition(symbol: string, hintPath?: string): Promise<SymbolPosition | null> {
    const { container, member } = parseDottedSymbol(symbol);
    const clients = await this.getClients(hintPath);
    let candidates: unknown[] = [];

    for (const client of clients) {
      const raw = await client.workspaceSymbols(symbol);
      if (raw.ok) candidates.push(...raw.value);
    }

    if (candidates.length === 0 && container !== null) {
      for (const client of clients) {
        const raw = await client.workspaceSymbols(member);
        if (!raw.ok) continue;
        for (const sym of raw.value) {
          const s = sym as Record<string, unknown>;
          const cn = typeof s["containerName"] === "string" ? s["containerName"] : null;
          if (cn === container || cn?.endsWith(`.${container}`)) candidates.push(sym);
        }
      }
    }

    if (candidates.length === 0) return null;
    const best = pickBestMatch(candidates, member, hintPath);
    if (!best) return null;

    const s = best as Record<string, unknown>;
    const loc = s["location"] as NormalizedLocation | undefined;
    if (!loc?.uri) return null;
    return { filePath: uriToPath(loc.uri), line: loc.range.start.line, character: loc.range.start.character };
  }

  /**
   * Return clients to query. If hintPath resolves to a supported language,
   * returns only that server. Otherwise returns all active servers.
   */
  private async getClients(hintPath?: string): Promise<LspClient[]> {
    if (hintPath) {
      const result = await this.registry.getClientForFile(hintPath);
      if (result.ok) return [result.value];
    }
    const clients: LspClient[] = [];
    for (const lang of this.registry.getActiveLanguages()) {
      const result = await this.registry.getClientForLanguage(lang);
      if (result.ok) clients.push(result.value);
    }
    return clients;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Read a single line (0-based) from a file. Returns "" on any error. */
async function readLineFromFile(filePath: string, line: number): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split("\n")[line]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Convert a normalized LSP Location to a LocationEntry with a one-line snippet. */
async function locationToEntry(location: NormalizedLocation, workspaceRoot: string): Promise<LocationEntry | null> {
  if (!location.uri) return null;
  const filePath = uriToPath(location.uri);
  const line0 = location.range.start.line;
  const snippet = await readLineFromFile(filePath, line0);
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

  const lines = text.split("\n").filter((l) => l.trim() !== "");
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
