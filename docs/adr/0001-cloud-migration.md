# ADR-0001: Migrate evergreenlabs-bot fully to the cloud

- **Status:** Accepted
- **Date:** 2026-05-24
- **Tracks:** [#3](https://github.com/SirWhack/evergreenlabs-bot/issues/3)
- **Supersedes:** N/A
- **Builds on:** the webhook + KV-queue Worker scaffolded for [#2](https://github.com/SirWhack/evergreenlabs-bot/issues/2)

## Context

The bot today is a Python CLI that runs on the user's local WSL machine. A Cloudflare Worker (`worker/`) intakes verified GitHub webhooks into a KV queue, and the Python bot polls and drains that queue when the machine happens to be awake. When the machine is asleep — most of the time — events sit in KV indefinitely. For a "personal site that updates itself," that's a leaky abstraction.

Goal: eliminate the local-machine dependency. The bot should run continuously in the cloud, draft via a hosted LLM, and publish to the website without any component sitting on the WSL/Windows box.

Constraints:
- LLM provider: OpenRouter ($10 credit loaded, plenty at projected ~750K tok/mo)
- Infra cost ceiling: ~free or <$5/mo (LLM spend separate)
- Commit metadata and diffs leaving the local network is acceptable (user controls the source repos)

## Decisions

### D1 — Hosting + language: Cloudflare Workers + Workflows, full TypeScript rewrite

The Python bot (~2144 LOC across ~21 files) ports cleanly: all deps are portable (httpx, openai SDK, click, dotenv, rich), no CPython-specific patterns, no native modules. The publish path shells out to `git` for a clone-edit-push dance that must be rewritten for any cloud target — that "port cost" is sunk regardless of host.

Rejected alternatives:
- **CF Containers (keep Python)** — newest CF product, less mature, debugging both code and platform.
- **Fly.io / Railway (keep Python)** — ships faster but introduces a long-running VM to babysit and locks in two languages (TS Worker + Python bot) with an awkward seam.
- **GitHub Actions cron** — 5-min minimum cadence; regression from the webhook→immediate-update story already built in #2.

Workflows additionally fit the bot's shape natively: each autorun cycle (poll → diff → draft → review → publish) is a multi-step pipeline that benefits from durable execution, retries, and observability.

### D2 — State storage: D1-only, JSON-blob-per-part

All mutable state lives in D1. The bot repo holds code only; the website repo only receives the rendered `siteData.js` via GitHub Contents API. No data commits to the bot repo.

Schema (sketched):
- `site_parts(name PRIMARY KEY, payload JSON, updated_at)` — profile, now, projects, contributions, roadmap, log; each a JSON blob.
- `drafts(id PRIMARY KEY, kind, payload JSON, source_repo, source_commits JSON, status, notes, created_at)`
- `skipped_repos(repo PRIMARY KEY, reason, skipped_at)`
- `cursors(repo, pipeline, last_sha, updated_at, PRIMARY KEY (repo, pipeline))` — backstop only; primary mechanism is `before`/`after` SHAs from webhook payload.
- `webhook_dedup(delivery_id PRIMARY KEY, seen_at)` — TTL-pruned.

Rejected: relational schemas for site parts (the data shape is designed for the website renderer, never queried internally), git-as-canonical (every draft mutation = 1 commit = noise + rate-limit risk), DO SQLite (overkill without a clear coordinator boundary), Turso/Postgres (external dependency for no gain).

`published_log` table dropped — confirmed dead code (defined in schema, never read or written).

### D3 — Trigger model: direct webhook → Workflow with per-repo singleton debounce

The KV queue exists only because the Python bot wasn't always-on. Once the bot is a Workflow, the queue is overengineered.

Shape: GitHub webhook → Worker verifies signature + delivery-id dedup → Worker calls `WORKFLOW.create({ id: repo-name })`. First call for a repo starts a Workflow instance that sleeps ~30s to coalesce burst pushes; subsequent calls within that window append events to D1 then noop. Instance wakes, drains pending events, drafts once, publishes once.

Retired:
- KV namespace `EVENTS` (replaced by direct Workflow trigger + D1 dedup)
- `/events` GET/DELETE endpoints
- `BOT_POLL_TOKEN` secret
- `bot poll-once` CLI command

Rejected: pure per-event Workflows (5 quick pushes would produce 5 separate log drafts instead of 1 consolidated entry); keeping the KV queue with a cron flush (worst-of-both — neither real-time nor simple).

### D4 — Publish path: GitHub Contents API

Forced by D1: no filesystem on Workers, no local clones. Replaces the `subprocess.run(["git", ...])` dance in `publish.py`. One PUT per `siteData.js` update.

### D5 — LLM: OpenRouter with `anthropic/claude-haiku-4.5` default

Prose quality matters (log entries and "now" text are the site's voice); JSON reliability matters for the `_judge` classifier; Haiku 4.5 is fast and cheap (~$1/mo at projected volume). `LLM_MODEL` env var stays as an override knob for running eval later.

Drop `REASONING_OVERHEAD_TOKENS` from the LLM client — it was a workaround for local Gemma/Qwen reasoning models that emit `reasoning_content` separately; mainstream OpenRouter chat models don't need it.

### D6 — Scheduling: daily 03:00 UTC cron + HTTP manual trigger

Two Workflow types:
- `per-repo-update` — webhook-triggered (D3), runs `log_drafter` + `introduce` (if `repository.created`) + publish.
- `daily-sync` — Workers cron trigger at 03:00 UTC + manual `POST /trigger/daily-sync` HTTP endpoint (bearer auth). Runs `roadmap_sync` (Projects v2 has no webhook) + `project_sync` + `introduce` backstop + publish.

Repo-list polling pattern unchanged: `daily-sync` fetches the user's public repos via GH API. Handles repos that exist without the GitHub App installed.

### D7 — Migration sequencing: hard cutover, rename `worker/` → `bot/`, delete Python at end

- **Cutover style:** hard cutover. Parallel-run gives fake safety because the Python bot is offline most of the time. Different state stores (D1 vs SQLite) would drift if both ran.
- **Repo layout:** rename `worker/` → `bot/`. The directory's role expands from "webhook intake" to "the whole bot"; the name should match.
- **Python CLI fate:** delete `src/evergreenlabs_bot/` entirely at end of migration. Local dev = `wrangler dev` + `curl` against the manual-trigger endpoint.
- **Review queue:** no UI for v1. Auto-accept drafts that pass sanity bars (same logic as today's `autorun._passes_sanity`); fumbled drafts log to D1 for inspection via `wrangler d1 execute`. Revisit with a small Worker admin UI if it becomes a real need.
- **Build order:**
  1. Scaffold: rename `worker/` → `bot/`, add D1 + Workflows bindings, port `llm_client.ts` and `state.ts` shells, add Contents API publish helper.
  2. First vertical slice: `log_drafter` end-to-end. Webhook → Workflow → D1 cursor read → fetch commits → LLM judge + draft → D1 write draft → auto-accept → render `siteData.js` → Contents API publish. Whole stack alive.
  3. Daily-sync Workflow: cron trigger + manual endpoint. Port `project_sync` first (no LLM, easiest port).
  4. Port remaining pipelines: `roadmap_sync`, `introduce`, `now_updater`.
  5. Cutover: flip GitHub App webhook URL, run `daily-sync` once, observe a real push event roundtrip, delete `src/evergreenlabs_bot/` and `pyproject.toml`.

## Consequences

**Positive:**
- Bot is always-on; webhook → publish loop becomes real-time.
- Single language (TS), single deployable, single state store.
- Free tier (Workers + D1 + Workflows + cron) covers infra; LLM ~$1/mo well under the $5/mo ceiling.
- Workflows give durable execution, retries, and per-step observability for free.

**Negative:**
- ~2–4 days of TS port work before cutover.
- Loss of git-as-audit-log for intermediate site state changes (only published `siteData.js` snapshots in site repo's git history). Acceptable for a personal site.
- Workers + D1 latency is a few ms per call vs. local SQLite μs — irrelevant at this scale.
- Cloudflare lock-in deepens. Migration off CF would require redoing D1, Workflows, and the webhook layer.

**Followups (out of scope here):**
- LLM eval (Haiku vs Llama vs Sonnet) once live traffic provides real samples.
- Review UI on the Worker if auto-accept misses become annoying.
- Drift check between D1 and published `siteData.js` (probably folded into `daily-sync`).
