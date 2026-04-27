# Slack Bridge: Secret Token Management

**Status:** Pre-implementation — for infosec review before any code is written.

## Tokens Required

| Token | Slack type | Required scopes | Used by |
|-------|-----------|-----------------|---------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) | `chat:write`, `channels:history`, `channels:read` | Bridge process (outbound + inbound) |
| `SLACK_CHANNEL_ID` | Not a secret — a channel identifier (`C0…`) | n/a | Bridge process |

One token total. The bot token is the only secret.

## Threat Model

The bridge is a **local-only, single-user developer tool**. It runs on the developer's machine as a standalone process alongside pi agent teams. It is not a server, has no inbound network listeners, and is never deployed to shared infrastructure.

| Threat | Mitigation |
|--------|------------|
| Token committed to git | `.env` in `.gitignore`; token read from env var, never from checked-in files |
| Token visible in process list | Passed via env var, not CLI arg — not in `ps` output |
| Token leaked to agent LLMs | Bridge is a separate process; agents have no tool or env var that exposes the token |
| Token in log files | Bridge logs events but never logs the token value; fetch wrapper strips `Authorization` from error output |

## Storage

```
# ~/.config/my-pi/.env  (or project-local .env — user's choice)
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0...
```

- The bridge reads `SLACK_BOT_TOKEN` from `process.env` at startup. No fallback, no default — missing token is a fatal error.
- No keychain integration for v1. The token sits in a dotfile with `0600` permissions, same as `~/.ssh/config` or `~/.aws/credentials`.
- `.env` is gitignored. The repo ships a `.env.example` with placeholder values.

## Token Lifecycle

| Event | Action |
|-------|--------|
| **Provisioning** | Developer creates a Slack App at api.slack.com, installs it to their workspace, copies the bot token. One-time manual step documented in a setup guide. |
| **Rotation** | Regenerate token in Slack App settings → update `.env` → restart bridge. No code change. |
| **Revocation** | Delete the Slack App or uninstall from workspace. Token becomes immediately invalid. |
| **Scope creep** | If future features need new scopes (e.g., `files:write` for large diff uploads), the Slack App is updated and the token is reinstalled — same `xoxb-` value may change. |

## What the Token Can Do

With the scopes listed above, a compromised token can:

- Post messages to channels the bot has been added to.
- Read message history in those channels.

It **cannot**: read DMs, access other workspaces, manage users, install apps, or access files outside its channels. Blast radius is limited to the channels the bot is explicitly invited to — ideally a single `#agent-teams` channel.

## Architecture Boundary

```
┌─────────────────┐     queue.json      ┌──────────────────┐
│  Agent team      │ ◄────────────────► │  Slack bridge     │
│  (pi processes)  │   (fs.watch)        │  (standalone)     │
│                  │                     │                   │
│  NO token access │                     │  SLACK_BOT_TOKEN  │
│  NO Slack calls  │                     │  in process.env   │
└─────────────────┘                     └────────┬──────────┘
                                                 │ HTTPS
                                                 ▼
                                        ┌────────────────┐
                                        │  Slack Web API  │
                                        └────────────────┘
```

The token never crosses into agent processes. Agents read/write the queue file; the bridge reads/writes the queue file and talks to Slack. The only shared state is the JSON queue — no token passes through it.

