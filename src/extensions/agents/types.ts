/**
 * Type definitions for the multi-agent coordination extension.
 *
 * Agent definitions describe the roles and capabilities of agents.
 * Team configuration describes a running team session.
 * No logic — only type declarations and constants.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of log entries kept in the queue file. */
export const MAX_LOG_ENTRIES = 50;

/** Filename prefix for team queue files in the worktree base dir. */
export const QUEUE_FILENAME_PREFIX = ".team-";

/** Prefix for tmux session names. */
export const TEAM_TMUX_PREFIX = "pi-team-";

/** Maximum number of concurrent ephemeral workers. */
export const MAX_CONCURRENT_WORKERS = 6;

/** Poll interval (ms) for monitor/wait tools checking the queue file. */
export const QUEUE_POLL_INTERVAL_MS = 3000;

/** Directory name for permanent agent role definitions. */
export const ROLES_DIR = "roles";

/** Directory name for ephemeral worker definitions. */
export const WORKERS_DIR = "workers";

// ---------------------------------------------------------------------------
// Agent definitions (parsed from .md files)
// ---------------------------------------------------------------------------

/** Whether an agent is permanent (long-lived) or an ephemeral worker. */
export type AgentRole = "permanent" | "worker";

/**
 * Parsed agent definition from a markdown file with YAML frontmatter.
 *
 * Permanent agents (orchestrator, evaluator) run for the entire team
 * session and maintain conversation history. Workers are spawned for
 * individual tasks and exit on completion.
 */
export interface AgentDefinition {
  /** Unique agent name (from frontmatter `name` field). */
  name: string;
  /** Whether this agent persists or is ephemeral. */
  role: AgentRole;
  /** Human-readable description of the agent's purpose. */
  description: string;
  /** LLM model identifier (e.g., "claude-sonnet-4-5"). Optional — uses default if omitted. */
  model?: string;
  /** Tool names the agent should have access to. Optional — uses defaults if omitted. */
  tools?: string[];
  /** System prompt content (the markdown body after frontmatter). */
  systemPrompt: string;
  /** Absolute path to the source .md file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Team session
// ---------------------------------------------------------------------------

/** Runtime status of an agent instance within a team session. */
export type AgentStatus = "starting" | "running" | "idle" | "done" | "error";

/** A running or completed agent instance within a team. */
export interface AgentInstance {
  /** Instance name (e.g., "orchestrator", "worker-1"). */
  name: string;
  /** Role from the agent definition. */
  role: AgentRole;
  /** Name of the agent definition this instance was created from. */
  definitionName: string;
  /** tmux window name within the team session. */
  tmuxWindow: string;
  /** Process ID of the pi process, if known. */
  pid?: number;
  /** Current runtime status. */
  status: AgentStatus;
}

/**
 * Full configuration for a running team session.
 *
 * Persisted alongside the queue file so the control plane can
 * reconnect to a running team after a session restart.
 */
export interface TeamSession {
  /** Unique team identifier (matches {@link TaskQueue.teamId}). */
  teamId: string;
  /** High-level objective (copied from queue). */
  goal: string;
  /** tmux session name. */
  tmuxSession: string;
  /** Absolute path to the queue file. */
  queuePath: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Absolute path to the working directory for agents. */
  workingDir: string;
  /** All agent instances (permanent and active workers). */
  agents: AgentInstance[];
  /** Unix timestamp (ms) when the team was created. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Agent-side configuration (passed to spawned agents via environment)
// ---------------------------------------------------------------------------

/**
 * Configuration injected into each spawned agent process.
 *
 * Passed as a JSON-encoded environment variable so the agent-side
 * extension knows which team it belongs to, what role it plays,
 * and where the queue file lives.
 */
export interface AgentSideConfig {
  /** Team ID this agent belongs to. */
  teamId: string;
  /** High-level goal for the team (displayed in UI). */
  goal: string;
  /** This agent's instance name. */
  agentName: string;
  /** Agent role (determines which tools are registered). */
  role: AgentRole;
  /** Absolute path to the queue file. */
  queuePath: string;
  /** Whether this agent can dispatch workers (orchestrator only). */
  canDispatch: boolean;
  /** Whether this agent can close tasks (evaluator only). */
  canClose: boolean;
  /** tmux session name (needed by orchestrator to spawn workers). */
  tmuxSession: string;
  /** Working directory for spawned worker processes. */
  workingDir: string;
  /** Absolute path to the agent-side extension file (for spawning workers). */
  agentSideExtensionPath: string;
  /** Directories to search for agent definitions, lowest priority first. */
  agentsDirs: string[];
  /** The agent's system prompt content (from the .md file body). Injected via before_agent_start. */
  agentSystemPrompt?: string;
}

/** Environment variable name for the agent-side config JSON. */
export const AGENT_CONFIG_ENV_VAR = "PI_TEAM_AGENT_CONFIG";
