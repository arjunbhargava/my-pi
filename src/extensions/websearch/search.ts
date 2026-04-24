/**
 * Tavily API client for web search.
 *
 * No pi imports. All failures are returned as structured Result values —
 * never thrown.
 */

import { DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT, type SearchResponse, type TavilyApiResponse } from "./types.js";

export type SearchWebResult = { ok: true; value: SearchResponse } | { ok: false; error: string };

/**
 * Search the web using the Tavily API.
 *
 * @param options.query - Search query string.
 * @param options.resultCount - Number of results to return (default DEFAULT_RESULT_COUNT, max MAX_RESULT_COUNT).
 * @param options.includeAnswer - Whether to request Tavily's synthesized answer (default true).
 * @param options.apiKey - Tavily API key.
 * @returns Structured result or error.
 */
export async function searchWeb(options: {
  query: string;
  resultCount?: number;
  includeAnswer?: boolean;
  apiKey: string;
}): Promise<SearchWebResult> {
  const resultCount = Math.min(options.resultCount ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);
  const includeAnswer = options.includeAnswer ?? true;

  let response: Response;
  try {
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        query: options.query,
        max_results: resultCount,
        include_answer: includeAnswer,
        search_depth: "basic",
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, error: `Tavily API error: HTTP ${response.status}` };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, error: "Tavily API returned malformed JSON" };
  }

  if (!isTavilyApiResponse(raw)) {
    return { ok: false, error: "Tavily API returned unexpected response shape" };
  }

  return {
    ok: true,
    value: {
      answer: raw.answer,
      results: raw.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
      })),
    },
  };
}

function isTavilyApiResponse(value: unknown): value is TavilyApiResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.results)) return false;
  for (const item of obj.results) {
    if (typeof item !== "object" || item === null) return false;
    const r = item as Record<string, unknown>;
    if (typeof r.title !== "string") return false;
    if (typeof r.url !== "string") return false;
    if (typeof r.content !== "string") return false;
    if (typeof r.score !== "number") return false;
  }
  return true;
}
