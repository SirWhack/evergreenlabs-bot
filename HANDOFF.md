# HANDOFF — evergreenlabs-bot cloud migration

Scratch context for resuming work on the cloud migration (#3) after a session reset.
This is a **scratch file**, not docs. Delete or rewrite freely.

## Where we are

- **ADR-0001** is the source of truth for architecture. Read it first: `docs/adr/0001-cloud-migration.md`.
- **CLAUDE.md** has the conventions. Read it second.
- The migration is sliced into 7 issues (#4–#10). Issue dependencies:
  - **#4 Slice 1 — scaffold** ✅ MERGED + DEPLOYED + VERIFIED (PR #11)
  - #5 Slice 2 — log_drafter (next, blocked by 1)
  - #6 Slice 3 — daily-sync + project_sync (next, blocked by 1, parallel with Slice 2)
  - #7 Slice 4 — roadmap_sync (blocked by 3)
  - #8 Slice 5 — introduce (blocked by 2 + 3)
  - #9 Slice 6 — now_updater (blocked by 2)
  - #10 Slice 7 — cutover, HITL (blocked by everything)

## Live infrastructure (already provisioned)

| Resource | Identifier |
|---|---|
| Worker URL | `https://evergreenlabs-bot.swynnr.workers.dev` |
| Routes | `POST /gh/webhook`, `POST /trigger/daily-sync`, `GET /health` |
| D1 database | `evergreenlabs-bot` (id `b54c264e-c79b-4deb-9719-08c32052a8c2`, in `bot/wrangler.toml`) |
| Workflows | `per-repo-update` (binding `PER_REPO_UPDATE`), `daily-sync` (binding `DAILY_SYNC`) |
| Cron | `0 3 * * *` UTC → `DAILY_SYNC` |
| GitHub App ID | 3841550 |
| GitHub App install ID | 135223603 (on `SirWhack`) |
| Website repo | `SirWhack/evergreenlabs`, siteData at `src/content/siteData.js` |
| Secrets set | `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `TRIGGER_TOKEN` |
| Vars in `wrangler.toml` | `GITHUB_USERNAME=SirWhack`, `WEBSITE_REPO_OWNER=SirWhack`, `WEBSITE_REPO_NAME=evergreenlabs`, `SITE_DATA_PATH=src/content/siteData.js`, `LLM_MODEL=anthropic/claude-haiku-4.5` |

Secret values live in the user's `.env` (gitignored).

## What Slice 1 actually shipped

Scaffold only — no real pipeline logic. Both Workflows just write a `tracer` row to `site_parts` and PUT a `_tracer` key into the website's `siteData.js`. Verified end-to-end:

- Manual: `curl -X POST https://evergreenlabs-bot.swynnr.workers.dev/trigger/daily-sync -H "Authorization: Bearer $TRIGGER_TOKEN"` → commit `chore(bot): daily-sync tracer @ …` on `SirWhack/evergreenlabs`.
- Webhook: a push to a SirWhack repo → commit `chore(bot): per-repo tracer @ …`.
- D1 `site_parts.tracer` row populated; `webhook_dedup` rows present (singleton debounce coalesced 3 deliveries into 1 commit).

Key code locations in `bot/src/`:
- `index.ts` — routes + webhook intake + D1 dedup + Workflow trigger
- `workflows/per-repo.ts`, `workflows/daily-sync.ts` — Workflow stubs (one tracer step each)
- `lib/state.ts` — D1 helpers (`getSitePart`, `putSitePart`, `seenDelivery`)
- `lib/publish.ts` — GitHub Contents API GET + deep-merge + PUT (mirrors Python `publish.py` output format: `export const SITE = {…};`)
- `lib/github.ts` — GitHub App auth via pure Web Crypto (no `@octokit/auth-app`); installation tokens cached with 5-min refresh margin
- `lib/llm.ts` — placeholder, throws; Slice 2 fills it in
- `lib/filter.ts`, `lib/verify.ts` — moved from `worker/`
- `migrations/0001_init.sql` — 5 tables per ADR §D2

## Known gotchas / land mines for next slices

1. **Self-feedback loop.** The bot is subscribed to push events on all SirWhack repos including `SirWhack/evergreenlabs` itself. Every publish from the bot fires another webhook back. Slice 1 was OK because the tracer is idempotent and singleton-per-repo debounce coalesced. **Slice 2's `log_drafter` MUST filter out commits authored by the bot's GitHub App** (otherwise it will log-draft its own commits forever). Suggested approach: check `commit.author.email` and skip if it matches the App's `<app-id>+<app-slug>[bot]@users.noreply.github.com`, or skip the entire `evergreenlabs` website repo from log_drafter. Confirm by inspecting the actual author email on `git log` of the website repo after Slice 1 commits.
2. **Site data file format.** The website renders `export const SITE = {…};` (note: `SITE`, not `siteData`). `publish.ts` already handles this — don't "fix" it back to `siteData`. The parser tolerates both shapes for forward-compat, but writes the Python-compatible `SITE` form.
3. **GitHub App permissions.** Already set to `Contents: R/W` on `evergreenlabs` and `Contents: R` + `Metadata: R` + `Pull requests: R` on source repos. Subscribed events include push, pull_request, create, delete, repository. If a new slice needs more, the user must update App perms + accept the new perms on the install page — the cached installation token continues with old scope until refresh (~1h).
4. **Old worker URL still referenced in `.env`.** `.env` has `WORKER_URL=https://evergreenlabs-bot-webhook.swynnr.workers.dev` — that's the dead old worker. New URL is `https://evergreenlabs-bot.swynnr.workers.dev`. Will be cleaned up at Slice 7 along with Python code.
5. **Legacy `worker/` dir.** Still on disk (only `.wrangler/` + `node_modules/` left after the merge; no tracked files). Will be `rm -rf`'d at Slice 7. Don't put anything new there.
6. **Empty `bot/src/pipelines/`.** Directory doesn't exist yet — Slice 2 creates it with `log_drafter.ts`.

## Python source for porting (read these before writing TS pipeline ports)

- `src/evergreenlabs_bot/pipelines/log_drafter.py` — judge prompt, draft prompt, sanity bar
- `src/evergreenlabs_bot/pipelines/project_sync.py` — deterministic, no LLM
- `src/evergreenlabs_bot/pipelines/roadmap_sync.py` — Projects v2 GraphQL + cached LLM
- `src/evergreenlabs_bot/pipelines/introduce.py` — README → blurb
- `src/evergreenlabs_bot/pipelines/now_updater.py` — log-aware "now" text
- `src/evergreenlabs_bot/llm_client.py` — drop `REASONING_OVERHEAD_TOKENS` per ADR §D5
- `src/evergreenlabs_bot/autorun.py` — has the auto-accept / sanity gate logic that wraps each pipeline
- `data/site/*.json` — canonical shapes for `siteData` consumers; tests should match these shapes

## Suggested next-session opener

> Read `HANDOFF.md`, then `docs/adr/0001-cloud-migration.md`, then `CLAUDE.md`. We're picking up the cloud migration. Slice 1 is merged + deployed + verified. I want to fan out Slice 2 (#5) and Slice 3 (#6) in parallel worktrees per the same pattern as Slice 1 — each agent writes code, opens its own PR, you handle the deploy/HITL gate. Confirm the plan, then launch both agents in parallel.

## Tasks (from prior session)

If task tool is fresh, recreate:
- Slice 2: Port log_drafter (issue #5) — AFK, blocked by deploy of Slice 2
- Slice 3: daily-sync body + project_sync (issue #6) — AFK, parallel with Slice 2
- Slice 4: roadmap_sync (issue #7) — blocked by 3
- Slice 5: introduce (issue #8) — blocked by 2 + 3
- Slice 6: now_updater (issue #9) — blocked by 2
- Slice 7: cutover (issue #10) — HITL, blocked by all

## Quick verification commands

```bash
# tail live logs
cd bot/ && npx wrangler tail

# fire the manual tracer (still works, useful smoke test after each deploy)
curl -X POST https://evergreenlabs-bot.swynnr.workers.dev/trigger/daily-sync \
  -H "Authorization: Bearer $TRIGGER_TOKEN"

# inspect state
cd bot/
npx wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT name, datetime(updated_at, 'unixepoch') AS updated FROM site_parts"
npx wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT * FROM drafts ORDER BY created_at DESC LIMIT 10"
npx wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT * FROM webhook_dedup ORDER BY seen_at DESC LIMIT 10"
npx wrangler d1 execute evergreenlabs-bot --remote \
  --command "SELECT * FROM cursors"

# describe latest workflow run
npx wrangler workflows instances list daily-sync
npx wrangler workflows instances describe daily-sync <instance-id>
```
