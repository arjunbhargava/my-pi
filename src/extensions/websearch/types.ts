/**
 * Type definitions and constants for the websearch extension.
 * No logic — only type declarations and constants.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of results to request from Tavily. */
export const DEFAULT_RESULT_COUNT = 5;

/** Maximum number of results to request from Tavily. */
export const MAX_RESULT_COUNT = 10;

/** Maximum characters to extract when fetching full page text. */
export const DEFAULT_FETCH_MAX_CHARS = 6000;

/** Environment variable name for the Tavily API key. */
export const TAVILY_API_KEY_ENV = "TAVILY_API_KEY";

/** Environment variable name for the Browserbase API key. */
export const BROWSERBASE_API_KEY_ENV = "BROWSERBASE_API_KEY";

/** Default navigation timeout for browser sessions in milliseconds. */
export const DEFAULT_BROWSE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single search result returned by the Tavily API. */
export interface SearchResult {
  title: string;
  url: string;
  /** Content snippet from the page (mapped from Tavily's `content` field). */
  snippet: string;
  score: number;
}

/** Structured response from a web search, with an optional synthesized answer. */
export interface SearchResponse {
  /** Tavily's synthesized answer, if `include_answer` was requested. */
  answer?: string;
  results: SearchResult[];
}

/** Raw shape returned by POST https://api.tavily.com/search. Only fields we use. */
export interface TavilyApiResponse {
  answer?: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
  }>;
}
