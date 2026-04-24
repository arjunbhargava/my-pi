/**
 * Tool registration for the websearch extension.
 *
 * Takes a registrar callback and typebox constructors as parameters —
 * no direct imports from `@mariozechner/pi-coding-agent`.
 */

import { searchWeb } from "./search.js";
import { fetchPageText } from "./fetch.js";
import { DEFAULT_FETCH_MAX_CHARS, DEFAULT_RESULT_COUNT, TAVILY_API_KEY_ENV, type SearchResponse } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi's registerTool uses complex generic types from typebox
type ToolRegistrar = (def: any) => void;

/**
 * Register the web_search and web_fetch tools.
 *
 * @param register    - The `pi.registerTool` function.
 * @param TypeObject  - `Type.Object` from typebox.
 * @param TypeString  - `Type.String` from typebox.
 * @param TypeOptional - `Type.Optional` from typebox.
 * @param TypeInteger  - `Type.Integer` from typebox.
 */
export function registerWebSearchTools(
  register: ToolRegistrar,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typebox schema constructors
  TypeObject: (...args: any[]) => any,
  TypeString: (...args: any[]) => any,
  TypeOptional: (...args: any[]) => any,
  TypeInteger: (...args: any[]) => any,
): void {
  registerWebFetchTool(register, TypeObject, TypeString, TypeOptional, TypeInteger);

  register({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Tavily. Returns a list of results with titles, URLs, and content snippets. " +
      "Optionally includes a synthesized direct answer. Use this before web_fetch — search snippets are often sufficient.",
    promptSnippet: "Search the web for information. Returns titles, URLs, snippets, and optionally a direct answer.",
    promptGuidelines: [
      "Use web_search to find information not available in the local codebase or conversation context.",
      "Prefer web_search snippets first. Only use web_fetch if the snippets lack the detail you need.",
    ],
    parameters: TypeObject({
      query: TypeString({ description: "Search query" }),
      resultCount: TypeOptional(TypeInteger({ description: "Number of results, 1-10, default 5" })),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const apiKey = process.env[TAVILY_API_KEY_ENV];
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "TAVILY_API_KEY environment variable is not set." }],
          details: {},
          isError: true,
        };
      }

      const query = params.query as string;
      const resultCount = typeof params.resultCount === "number" ? params.resultCount : DEFAULT_RESULT_COUNT;

      const result = await searchWeb({ query, resultCount, apiKey });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Search failed: ${result.error}` }],
          details: {},
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatSearchOutput(result.value) }],
        details: { resultCount: result.value.results.length, hasAnswer: result.value.answer !== undefined },
      };
    },
  });
}

function registerWebFetchTool(
  register: ToolRegistrar,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typebox schema constructors
  TypeObject: (...args: any[]) => any,
  TypeString: (...args: any[]) => any,
  TypeOptional: (...args: any[]) => any,
  TypeInteger: (...args: any[]) => any,
): void {
  register({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and extract its readable text content. Use after web_search when snippets don't contain enough detail. " +
      "Returns plain text stripped of HTML markup, truncated to a configurable limit.",
    promptSnippet: "Fetch a URL and extract readable text content from the page.",
    promptGuidelines: [
      "Use web_fetch only after web_search, when search result snippets lack the detail needed. Do not use web_fetch speculatively on multiple URLs.",
    ],
    parameters: TypeObject({
      url: TypeString({ description: "URL to fetch" }),
      maxChars: TypeOptional(TypeInteger({ description: "Maximum characters to extract, default 6000" })),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const url = params.url as string;
      const maxChars = typeof params.maxChars === "number" ? params.maxChars : DEFAULT_FETCH_MAX_CHARS;

      const result = await fetchPageText({ url, maxChars });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Fetch failed: ${result.error}` }],
          details: {},
          isError: true,
        };
      }

      const { charCount, truncated } = result.value;
      const truncatedNote = truncated ? ", truncated" : "";
      const header = `[Fetched: ${url}]\n[${charCount} chars extracted${truncatedNote}]\n\n`;
      return {
        content: [{ type: "text", text: header + result.value.text }],
        details: { url, charCount, truncated },
      };
    },
  });
}

function formatSearchOutput(response: SearchResponse): string {
  const lines: string[] = [];

  if (response.answer) {
    lines.push("[Answer]");
    lines.push(response.answer);
    lines.push("");
  }

  lines.push("[Results]");
  for (let i = 0; i < response.results.length; i++) {
    const r = response.results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    lines.push(`   ${r.snippet}`);
    if (i < response.results.length - 1) lines.push("");
  }

  return lines.join("\n");
}
