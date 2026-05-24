# bot/ — evergreenlabs-bot (Cloudflare Workers + Workflows + D1)

The cloud-native bot. See [`../docs/adr/0001-cloud-migration.md`](../docs/adr/0001-cloud-migration.md) for the architecture and [`../CLAUDE.md`](../CLAUDE.md) for repo conventions.

## Layout

```
bot/
  src/
    index.ts              # Worker entrypoint: /gh/webhook, /trigger/daily-sync, /health
    workflows/
      per-repo.ts         # Singleton-per-repo Workflow (PerRepoUpdate)
      daily-sync.ts       # Cron + manual Workflow (DailySync)
    pipelines/            # log_drafter, project_sync, ... (later slices)
    lib/
      llm.ts              # OpenRouter client (Slice 2 fills in)
      state.ts            # D1 helpers (site_parts, webhook_dedup, ...)
      publish.ts          # GitHub Contents API publish helper
      github.ts           # GitHub App auth + REST client
      filter.ts           # Coarse webhook filter
      verify.ts           # HMAC signature verification
  migrations/
    0001_init.sql         # site_parts, drafts, skipped_repos, cursors, webhook_dedup
  wrangler.toml
  package.json
```

## Slice 1 status

This is the hollow tracer-bullet slice. Both Workflows (`PerRepoUpdate`, `DailySync`) write a `tracer` row to `site_parts` and publish a `_tracer` key into the website's `siteData.js`. No LLM, no real draft logic — proves the spine end-to-end.

## GitHub App auth: pure Web Crypto

`lib/github.ts` signs the App JWT with `crypto.subtle` (RSASSA-PKCS1-v1_5 / SHA-256) — no `@octokit/auth-app`. Both PKCS#1 (`BEGIN RSA PRIVATE KEY`) and PKCS#8 (`BEGIN PRIVATE KEY`) PEMs are accepted. Installation tokens cache in module scope with a 5-minute refresh margin.

## First-time setup

```bash
cd bot/
npm install

# 1. Create the D1 database; copy the returned database_id into wrangler.toml.
wrangler d1 create evergreenlabs-bot

# 2. Apply the schema locally + remotely.
npm run migrate:local
npm run migrate:remote

# 3. Set secrets (interactive prompt for each).
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_INSTALLATION_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste full PEM
wrangler secret put OPENROUTER_API_KEY
wrangler secret put TRIGGER_TOKEN            # `openssl rand -hex 32`

# 4. Deploy.
npm run deploy
```

GitHub App permissions required:
- `Contents: Read & Write` on the website repo (so the App can PUT `siteData.js`)
- `Contents: Read`, `Metadata: Read` on tracked source repos
- `Pull requests: Read`, plus webhook subscriptions for `push`, `pull_request`, `create`, `delete`, `repository`

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill in
npm run dev
```

`.dev.vars` is gitignored.

## Verifying the tracer

Two paths exercise the full spine — webhook and manual cron trigger:

**Webhook path.** Push to any SirWhack repo and watch the website repo's commit log for `chore(bot): per-repo tracer @ <ts>`. The published `siteData.js` will gain a `_tracer` object:

```json
{
  "_tracer": {
    "lastTracerRun": "2026-05-24T20:34:11.123Z",
    "kind": "per-repo",
    "repo": "SirWhack/some-repo",
    "delivery_id": "..."
  }
}
```

**Manual / cron path.**

```bash
curl -X POST https://<worker>/trigger/daily-sync \
  -H "Authorization: Bearer $TRIGGER_TOKEN"
# expect: 202 { "id": "<workflow-instance-id>" }
```

Inspect D1 directly:

```bash
wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT name, updated_at FROM site_parts"

wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT * FROM webhook_dedup ORDER BY seen_at DESC LIMIT 5"
```

## Common dev commands

```bash
wrangler dev                                  # local Worker, hot reload
wrangler d1 execute evergreenlabs-bot --local --file migrations/0001_init.sql
wrangler d1 execute evergreenlabs-bot --local --command "SELECT * FROM drafts"
wrangler deploy
wrangler tail                                 # stream logs from prod
curl -X POST https://<worker>/trigger/daily-sync \
  -H "Authorization: Bearer $TRIGGER_TOKEN"
```

## Routes

| Method | Path                    | Auth                              | Purpose                                                  |
|--------|-------------------------|-----------------------------------|----------------------------------------------------------|
| GET    | `/health`               | none                              | Liveness probe                                           |
| POST   | `/gh/webhook`           | HMAC `X-Hub-Signature-256`        | GitHub webhook intake -> `PER_REPO_UPDATE.create()`      |
| POST   | `/trigger/daily-sync`   | `Authorization: Bearer <token>`   | Manually invoke `DAILY_SYNC` Workflow                    |

## Anti-patterns (also in CLAUDE.md)

- No KV writes — `webhook_dedup` lives in D1.
- No `git` subprocess — publish goes through the Contents API.
- No filesystem — Workers has none.
- No new LLM call sites outside `lib/llm.ts`.

## Secret rotation

```bash
wrangler secret put <NAME>      # overwrite with new value
```

For `GITHUB_WEBHOOK_SECRET`, also update the GitHub App's webhook secret in the UI. Brief delivery failures during overlap; GitHub retries.
