# ADR-0002: Add an MCP server to the Worker for agent-driven project management

- **Status:** Accepted
- **Date:** 2026-05-25
- **Tracks:** TBD
- **Supersedes:** N/A
- **Builds on:** [ADR-0001](0001-cloud-migration.md)

## Context

The bot automates site content — log entries, project cards, roadmap commentary, "now" text — but there is no interface for managing the bot or the project board outside of raw D1 queries, curl commands, and the GitHub Projects UI. When working in Claude Code on any repo, an agent has no way to see what the bot knows about that repo, manage board items, or trigger syncs without reading a skill file and assembling git/curl commands manually.

The goal is an API surface that gives any Claude Code session — in any repo — immediate context about the project and tools to manage the GitHub Projects v2 board, without bypassing the bot's editorial pipeline.

MCP (Model Context Protocol) is the natural fit: Claude Code already supports remote MCP servers, and the protocol gives agents typed tools with descriptions that orient them on when and how to act.

## Decisions

### D1 — Scope: project board management + read-only context, no editorial overrides

The MCP server exposes two clusters of tools:

1. **Project board CRUD** — create, update, close, and list items on the GitHub Projects v2 board.
2. **Read-only context** — orient an agent on a specific repo (project entry, board items, recent logs, draft status, skip status) or the system as a whole.

Additionally, two sync triggers let agents kick off the bot's existing pipelines on demand.

Site content (projects, log entries, now text, roadmap commentary) remains wholly managed by the bot's automated pipelines. The MCP server has no tools that write to `site_parts` or `drafts` in D1. This keeps the bot as the single writer for site content, preventing agents from bypassing the editorial pipeline (LLM drafting, sanity checks, auto-accept logic). If an agent wants to change how a project appears on the site, it updates the source (repo metadata, board items) and lets the bot's normal sync cycle pick it up.

Rejected: exposing editorial overrides (update_project, approve_draft, skip_repo) through MCP. The bot's pipeline is the authority on site content — a "cut-through" write path would create two sources of truth and undermine the sanity-check layer the bot provides.

### D2 — One project board, not one per repo

All repos share a single GitHub Projects v2 board. The board has a Repository field for filtering by repo within the single board.

One board gives cross-project prioritization in a single view. The bot's `roadmap_sync` pipeline already queries one board. Multiple boards would require enumerating and querying each separately, with no unified priority ordering, for no benefit at single-developer scale.

Rejected: per-repo boards. More GraphQL queries, no unified prioritization, more wiring — solves a multi-team coordination problem that doesn't exist here.

### D3 — Same Worker, new `/mcp` route

The MCP handler lives in the existing `bot/src/index.ts` Worker alongside the webhook and trigger routes. It shares the same `Env` bindings (D1, GitHub App creds, secrets).

The MCP tools need D1 reads (for `get_repo_context`) and GitHub App auth (for Projects v2 GraphQL writes). Both are already wired in the Worker. A separate Worker would duplicate the entire auth stack and D1 binding config while pointing at the same database — complexity without isolation benefit, since it's all personal infra on the same Cloudflare account.

Rejected: separate Worker. No isolation benefit (a bad MCP request can't crash a concurrent webhook handler — Workers handles requests independently), and it would duplicate auth, bindings, and deployment config.

### D4 — Auth: dedicated `MCP_TOKEN` secret with bearer middleware

A dedicated `MCP_TOKEN` secret, separate from the existing `TRIGGER_TOKEN`, protects the `/mcp` route. Middleware checks `Authorization: Bearer <token>` before requests reach the MCP handler.

The two tokens protect different surfaces with different risk profiles: `TRIGGER_TOKEN` kicks off an idempotent sync (low risk), while `MCP_TOKEN` can write to the GitHub Projects board (higher risk, not idempotent). Separate secrets mean rotating one doesn't disrupt the other.

Claude Code connects via:
```
claude mcp add --transport http evergreenlabs-bot \
  https://evergreenlabs-bot.swynnr.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Rejected: reusing `TRIGGER_TOKEN` (conflates two risk profiles, one rotation breaks both); full OAuth 2.1 (Cloudflare's `workers-oauth-provider` supports it, but it's ceremony for a single-user server); Cloudflare Access / Zero Trust (adds identity infra to protect a personal project board).

### D5 — Repo identification: `owner/repo` wire format

MCP tools that operate on a specific repo accept the full `owner/repo` string (e.g., `SirWhack/evergreenlabs-bot`). This matches GitHub's canonical form and the existing data in D1 (`source_repo` on drafts, `repo` on cursors).

In practice, agents infer this from the git remote of whatever repo they're working in — the user never types it. The full `owner/repo` format is unambiguous and handles edge cases (username renames, forks) without the MCP server needing to assume a default owner.

Rejected: short repo name only (requires the server to assume an owner, breaks if you ever work on a fork or collaborative repo); opaque IDs (agents can't construct them without a lookup step).

### D6 — Board write fields: title, status, priority, kind, repo — with auto-set repo

All five existing Projects v2 fields are writable through `create_item` and `update_item`: title, status, priority, kind, and repo.

If the agent provides repo context (from `get_repo_context` or its git remote), `create_item` auto-populates the Repo field unless explicitly overridden. This removes a friction step — an agent working in a repo shouldn't have to specify which repo the board item belongs to.

Draft items (no linked issue/PR) are allowed. They're the lowest-friction path from "I need to do X" to a board item, without requiring the agent to create an issue first.

GitHub Projects v2 mutations require field node IDs for single-select fields. The MCP server fetches the project's field schema on first use and caches the human-readable-value → node-ID mapping. `roadmap_sync` already performs this read; the mapping logic becomes shared.

### D7 — Sync triggers exposed as MCP tools

Two triggers are available through the MCP:

- `trigger_daily_sync` — runs the full pipeline (project_sync → introduce backstop → roadmap_sync → publish). Same as `POST /trigger/daily-sync`.
- `trigger_repo_sync` — runs the per-repo workflow for a specific repo (fetch commits → draft logs → now update → publish).

These are not editorial overrides — they invoke the bot's normal decision-making pipeline on demand. The primary use case: an agent creates board items and wants the site's roadmap page to reflect them without waiting for the 03:00 UTC cron.

### D8 — Tool descriptions: opinionated but lean

MCP tool descriptions carry enough intent for an agent to know *when* to reach for the tool, not how the bot works internally. The MCP replaces the need for agents to read a skill file — the tool descriptions are the orientation layer.

Each description is one to two sentences focused on the trigger condition ("call this when...") and the shape of what comes back. No internal implementation details, no bot architecture.

### D9 — No MCP resources, tools only

The MCP server does not expose MCP resources (static data declarations). All reads go through tools (`get_repo_context`, `list_items`, `get_site_status`).

MCP resources can't auto-inject into context based on which repo an agent is working in — the agent still has to decide to read them, same as a tool call. Tools are the more honest interface: they let the agent ask scoped questions instead of ingesting the full projects array or log history.

Rejected: exposing `site_parts` rows as MCP resources. Dumps unscoped data into context; doesn't solve the "orient the agent on this repo" problem any better than `get_repo_context`.

## Tool inventory

| Tool | Cluster | Description |
|---|---|---|
| `get_repo_context` | Context | Everything the bot knows about a repo: project entry, board items, recent logs, draft status, skip status. Call first when starting work on any repo. |
| `get_site_status` | Context | System overview: project count, pending drafts, last sync time, board item counts. |
| `list_items` | Board | Query board items with optional filters (repo, status, priority). |
| `create_item` | Board | Add an item to the project board. Auto-sets repo from caller context. |
| `update_item` | Board | Modify fields on an existing board item. |
| `close_item` | Board | Mark a board item done/archived. |
| `trigger_daily_sync` | Trigger | Run the full sync pipeline. |
| `trigger_repo_sync` | Trigger | Run the per-repo pipeline for a specific repo. |

## Consequences

**Positive:**
- Any Claude Code session in any repo gets immediate project context and board management without reading skills or assembling curl commands.
- GitHub Projects v2 board becomes the single source of truth for roadmap; agents write to it, the bot syncs it to the site.
- Bot's editorial authority over site content is preserved — no bypass path.
- Same Worker, same auth stack, same D1 — no new infrastructure to deploy or maintain.
- Dedicated MCP token isolates the auth surface from webhook and trigger auth.

**Negative:**
- Adds ~200-400 LOC to the Worker (MCP handler, tool implementations, field-ID caching).
- Projects v2 GraphQL mutations require field node IDs that can change if the board schema is edited in the GitHub UI — the cache needs invalidation logic or a TTL.
- MCP protocol is still maturing; transport or auth conventions may shift (mitigated by Cloudflare's Agents SDK tracking the spec).

**Followups (out of scope here):**
- Resume generation as a website feature (not a bot or MCP concern).
- Weekly digest email using existing log/roadmap data.
- RSS feed generation from log entries.
