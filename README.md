# evergreenlabs-bot

Cloud-native automation for the [evergreenlabs](https://github.com/SirWhack/evergreenlabs) website. Watches all public SirWhack repos via GitHub webhooks, drafts log entries from logworthy commits via LLM, and publishes back to the website's `siteData.js`.

Runs entirely on Cloudflare Workers + Workflows + D1. No local machine dependency.

## Architecture

- **Cloudflare Worker** at `https://evergreenlabs-bot.swynnr.workers.dev`
- **Two Workflows:**
  - `PerRepoUpdate` — webhook-triggered. Debounces pushes per repo, then runs: introduce (for new repos) → log_drafter (judge + draft) → now_updater → publish.
  - `DailySync` — cron (03:00 UTC) + manual trigger. Runs: project_sync → introduce backstop → roadmap_sync → publish.
- **D1** for all mutable state (site_parts, drafts, cursors, skipped_repos, webhook_dedup, pending_events).
- **GitHub Contents API** for publishing `siteData.js` (no git clones).
- **OpenRouter** (`anthropic/claude-haiku-4.5`) for LLM calls.

## Development

```bash
cd bot/
npm install
npm run migrate:local          # apply D1 schema locally
npx wrangler dev               # local Worker with hot reload

# smoke test
curl -X POST http://localhost:8787/trigger/daily-sync \
  -H "Authorization: Bearer $TRIGGER_TOKEN"
```

## Deployment

```bash
cd bot/
npx wrangler deploy
npm run migrate:remote         # apply any new migrations to live D1

# manual trigger
curl -X POST https://evergreenlabs-bot.swynnr.workers.dev/trigger/daily-sync \
  -H "Authorization: Bearer $TRIGGER_TOKEN"
```

## Configuration

Non-secret config lives in `bot/wrangler.toml` `[vars]`. Secrets are set via `wrangler secret put <NAME>`.

Required secrets: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `OPENROUTER_API_KEY`, `TRIGGER_TOKEN`.

## Decisions

See `docs/adr/0001-cloud-migration.md` for the full architecture decision record.
