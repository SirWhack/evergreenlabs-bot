# CLAUDE.md

Guidance for AI agents working in this repo.

## Project state: mid-migration

This project is being rewritten from a local Python CLI to a fully cloud-native Cloudflare Workers + Workflows + D1 bot. **Read [`docs/adr/0001-cloud-migration.md`](docs/adr/0001-cloud-migration.md) before doing any structural work.** That ADR is the source of truth for architecture; this file describes conventions.

- The legacy implementation lives in `src/evergreenlabs_bot/` (Python). It will be deleted at cutover. Do not extend it.
- The new implementation lives in `bot/` (TypeScript, Cloudflare Workers).
- All new code goes in `bot/`. Site data conventions (the JSON schema for `siteData.js`) are unchanged from the Python version — see `data/site/*.json` for the canonical shape.

## Repo layout (post Slice 1)

```
bot/
  src/
    index.ts            # Worker entrypoint: webhook intake, HTTP trigger, MCP server
    mcp/
      handler.ts        # MCP Streamable HTTP handler (JSON-RPC dispatch)
      tools.ts          # MCP tool definitions + execution handlers
      board.ts          # GitHub Projects v2 GraphQL mutations + schema cache
    workflows/
      per-repo.ts       # singleton-per-repo Workflow (push, repository.created)
      daily-sync.ts     # cron + manual trigger Workflow
    pipelines/          # log_drafter.ts, project_sync.ts, roadmap_sync.ts, introduce.ts, now_updater.ts
    lib/
      llm.ts            # OpenRouter client (replaces old Python llm_client.py)
      state.ts          # D1 reads/writes
      publish.ts        # GitHub Contents API publish helper
      github.ts         # GH API client (Octokit or fetch-based)
  migrations/
    0001_init.sql       # D1 schema (site_parts, drafts, skipped_repos, cursors, webhook_dedup)
  wrangler.toml
  package.json
docs/
  adr/                  # decisions; new ADRs require a new number, never edit accepted ones
data/site/              # legacy Python canonical state — informational only post-migration
```

## Conventions

**Storage:** All mutable state goes to D1 via `lib/state.ts`. Do not use KV for new state (the legacy `EVENTS` KV namespace is being retired). Do not write to the filesystem — Workers has no persistent FS.

**Publishing:** Site updates go through `lib/publish.ts`, which calls the GitHub Contents API. Do not shell out to `git`. Do not clone repos.

**LLM:** All LLM calls go through `lib/llm.ts`. Default model `anthropic/claude-haiku-4.5` via OpenRouter; respect the `LLM_MODEL` env var as an override. Do not hardcode model names in pipelines.

**Workflows over Workers for multi-step work:** Anything that fetches GH data, calls an LLM, and writes results belongs in a Workflow step, not a bare Worker handler. Workflows give you durable execution and per-step retries.

**Secrets:** Set with `wrangler secret put NAME`. Never commit secrets. The `.env` file is local-only and gitignored. Required secrets: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `OPENROUTER_API_KEY`, `TRIGGER_TOKEN`, `MCP_TOKEN`, `GITHUB_PAT_PROJECTS`.

**MCP server:** The Worker exposes an MCP endpoint at `/mcp` (ADR-0002). It provides board management tools (CRUD on GitHub Projects v2) and read-only context queries (repo info, site status). Auth is bearer token via `MCP_TOKEN`. The MCP server does NOT write site content — the bot's pipelines are the sole authority. See `bot/src/mcp/` for implementation.

**Webhook trigger model:** GitHub webhook → Worker (`/gh/webhook`) verifies signature + delivery-id dedup in D1 → `WORKFLOW.create({ id: repo-name })`. Singleton-per-repo instance debounces ~30s to coalesce bursts. Do not reintroduce a queue.

**Cron + manual trigger:** Daily 03:00 UTC cron runs `daily-sync`. `POST /trigger/daily-sync` with bearer auth invokes the same Workflow manually.

## Common dev commands (post Slice 1)

```bash
cd bot/
wrangler dev                                  # local Worker, hot reload
wrangler d1 execute evergreenlabs-bot --local --file migrations/0001_init.sql
wrangler d1 execute evergreenlabs-bot --local --command "SELECT * FROM drafts"
wrangler deploy                               # deploy to CF
wrangler secret put OPENROUTER_API_KEY        # interactive secret entry
curl -X POST https://<worker>/trigger/daily-sync -H "Authorization: Bearer $TRIGGER_TOKEN"

# MCP server — connect from Claude Code
wrangler secret put MCP_TOKEN                 # set the MCP bearer token
claude mcp add --transport http evergreenlabs-bot https://<worker>/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

## Anti-patterns

- Don't extend `src/evergreenlabs_bot/*.py` — it's getting deleted at cutover.
- Don't add new code to `worker/src/` after Slice 1 lands (it's been renamed to `bot/src/`).
- Don't reintroduce the KV `EVENTS` queue.
- Don't shell out to `git`; use Contents API.
- Don't use SQLite/local FS; use D1.
- Don't add a new top-level config format — use `wrangler.toml` `[vars]` for non-secret config, `wrangler secret` for secrets.
- Don't add MCP tools that write to `site_parts` or `drafts` — the bot's pipelines are the sole writer for site content (ADR-0002 §D1).

## When in doubt

1. Re-read `docs/adr/0001-cloud-migration.md`.
2. Check the parent issue (#3) for the latest status across slices.
3. Look at what the predecessor slice produced; subsequent slices extend, not reinvent.
