/**
 * LSP extension entry point.
 *
 * Wires language-server lifecycle, document synchronization, and auto-diagnostic
 * injection into pi. This is the only file in the extension that imports from
 * `@mariozechner/pi-coding-agent`.
 */

import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getRepositoryRoot } from "../../lib/git.js";
import type { GitContext } from "../../lib/types.js";
import { ServerRegistry } from "./registry.js";
import { SymbolResolver } from "./resolver.js";
import { SERVER_CONFIGS } from "./types.js";
import { registerLspTools } from "./tools.js";

export default function lspExtension(pi: ExtensionAPI): void {
  let registry: ServerRegistry | null = null;
  let resolver: SymbolResolver | null = null;
  let workspaceRoot = "";
  const diagTimers = new Map<string, ReturnType<typeof setTimeout>>();

  pi.on("session_start", async (_event, ctx) => {
    // Only initialize once per extension lifetime — tools already hold
    // references to the first registry/resolver instances.
    if (registry) return;

    const gitCtx: GitContext = {
      exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
      cwd: ctx.cwd,
    };
    const rootResult = await getRepositoryRoot(gitCtx);
    workspaceRoot = rootResult.ok ? rootResult.value : ctx.cwd;

    registry = new ServerRegistry(workspaceRoot);
    resolver = new SymbolResolver(registry, workspaceRoot);
    registerLspTools(registry, resolver, pi.registerTool.bind(pi), Type.Object, Type.String, Type.Optional);
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!registry) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;

    const filePath = typeof event.input["path"] === "string" ? event.input["path"] : undefined;
    if (!filePath) return;

    // Only proceed if there is already an active server for this file type —
    // we must not spawn a server as a side-effect of a file edit.
    const ext = extname(filePath).replace(/^\./, "").toLowerCase();
    const hasActiveServer = registry.getActiveLanguages().some((lang) => {
      const config = SERVER_CONFIGS.find((c) => c.languageId === lang);
      return (config?.fileExtensions as readonly string[] | undefined)?.includes(ext) ?? false;
    });
    if (!hasActiveServer) return;

    const content = await readFile(filePath, "utf8").catch(() => null);
    if (content === null) return;

    await registry.notifyChange(filePath, content);

    // Debounce: give the server 500 ms to emit publishDiagnostics before reading.
    const existing = diagTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const capturedRegistry = registry;
    const timer = setTimeout(() => {
      diagTimers.delete(filePath);

      const errorLines: string[] = [];
      for (const lang of capturedRegistry.getActiveLanguages()) {
        const buffer = capturedRegistry.getDiagnosticsBuffer(lang);
        if (!buffer) continue;
        for (const d of buffer.getForFile(filePath)) {
          if (d.severity === "error") errorLines.push(`${d.path}:${d.line}: ${d.message}`);
        }
      }

      if (errorLines.length > 0) {
        pi.sendMessage(
          {
            customType: "lsp_diagnostics",
            content: `[LSP] Diagnostics for ${filePath}:\n${errorLines.join("\n")}`,
            display: true,
          },
          { deliverAs: "steer" },
        );
      }
    }, 500);
    diagTimers.set(filePath, timer);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    for (const timer of diagTimers.values()) clearTimeout(timer);
    diagTimers.clear();
    if (registry) await registry.disposeAll();
  });
}
