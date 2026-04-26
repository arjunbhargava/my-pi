/**
 * Collects environment variables from the current process that should
 * be propagated to spawned team-agent processes.
 *
 * Spawned agents run inside non-interactive bash scripts launched via
 * tmux, which means no shell RC files (.zshenv, .bashrc, .zprofile)
 * are sourced. Without explicit propagation, API keys and tokens are
 * invisible to child agents on both macOS and Linux.
 *
 * This module is the single source of truth for which env vars get
 * forwarded. Add new provider prefixes here as needed.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Env var name prefixes for LLM providers and tool services.
 * Matched case-insensitively against the start of each var name.
 */
const PROVIDER_PREFIXES: readonly string[] = [
  "ANTHROPIC",
  "OPENAI",
  "AWS",
  "AZURE",
  "GOOGLE",
  "TAVILY",
  "GROQ",
  "MISTRAL",
  "COHERE",
  "DEEPSEEK",
  "FIREWORKS",
  "HUGGING",
  "PERPLEXITY",
  "REPLICATE",
  "TOGETHER",
  "BEDROCK",
  "BROWSERBASE",
  "VERTEX",
  "OLLAMA",
];

/**
 * Env var name suffixes that typically hold secrets.
 * Matched case-insensitively against the end of each var name.
 */
const SECRET_SUFFIXES: readonly string[] = [
  "API_KEY",
  "API_TOKEN",
  "SECRET",
  "BEARER_TOKEN",
  "ACCESS_TOKEN",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a map of env vars from the current process that match known
 * provider or secret patterns. Only vars with non-empty values are
 * included.
 *
 * @returns Record of env var name → value to propagate.
 */
export function collectPropagatedEnvVars(): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (shouldPropagate(key)) {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Determine whether an env var name matches propagation criteria. */
function shouldPropagate(name: string): boolean {
  const upper = name.toUpperCase();

  for (const prefix of PROVIDER_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }

  for (const suffix of SECRET_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }

  return false;
}
