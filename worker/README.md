# evergreenlabs-bot webhook worker

Cloudflare Worker that receives GitHub webhooks, verifies them, and queues
event records in KV for the local bot to drain on its next poll.

## What it does

```
GitHub App ──► POST /gh/webhook ──► verify HMAC ──► dedup ──► filter ──► enqueue (KV)
                                                                                 │
Local bot   ──► GET /events     ──► authed list ◄─────────────────────────────────┘
            ──► DELETE /events  ──► authed drain after successful autorun
```

## One-time setup

Order matters: create the KV namespace and webhook secret first, then deploy,
then create the GitHub App pointing at the deployed URL.

### 1. Generate the two secrets locally

```bash
# 32 bytes hex, used as the GitHub App's webhook secret
openssl rand -hex 32
# 32 bytes hex, used as the bearer token the bot presents on /events
openssl rand -hex 32
```

Keep both somewhere safe — you'll paste them into `wrangler secret put` and
into `.env` / GitHub UI in later steps.

### 2. Install + log in to wrangler

```bash
cd worker
npm install
npx wrangler login
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create EVENTS
```

Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Set secrets

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET   # paste GH webhook secret
npx wrangler secret put BOT_POLL_TOKEN          # paste bot bearer token
```

Confirm `GITHUB_USERNAME` in `wrangler.toml` matches your GitHub login.

### 5. Deploy

```bash
npx wrangler deploy
```

Note the deployed URL (something like
`https://evergreenlabs-bot-webhook.<subdomain>.workers.dev`). The webhook
endpoint is `<URL>/gh/webhook`.

### 6. Create the GitHub App

In GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

| Field | Value |
|---|---|
| Name | `evergreenlabs-bot-webhook` (or any unique name) |
| Homepage URL | Your site / repo URL |
| Webhook URL | `<worker-url>/gh/webhook` |
| Webhook secret | The `GITHUB_WEBHOOK_SECRET` from step 1 |
| Repository permissions | `Contents: Read`, `Pull requests: Read`, `Metadata: Read` |
| Subscribe to events | `Push`, `Pull request`, `Create`, `Delete` |
| Where can this be installed | Only on this account |

Save. Then **Install App** → install on your user account → grant access to
all repos (or selected repos).

> **Note on roadmap updates**: `projects_v2_item` webhooks are only emitted
> for org-owned Projects v2 boards, not user-owned ones. Roadmap changes will
> not be push-driven; they'll continue to refresh on the daily 9am cron
> backstop. If/when this repo moves under an org, re-add `projects_v2_item`
> to the subscriptions and re-add the corresponding branch to
> `src/filter.ts`.

The App's *private key* is not used at runtime — the bot only needs the
webhook signature secret. You can leave the private key unused, or skip
generating one.

### 7. Verify delivery

Trigger a push to a tracked repo, then:

- GitHub UI → your App → **Recent Deliveries** should show a `200 OK`.
- `npx wrangler tail` should show the request with HMAC verified.
- `npx wrangler kv key list --binding EVENTS` should show one `queue:` key.

Forged request check:

```bash
curl -X POST "<worker-url>/gh/webhook" \
  -H "X-Hub-Signature-256: sha256=deadbeef" \
  -H "X-GitHub-Delivery: $(uuidgen)" \
  -H "X-GitHub-Event: push" \
  -d '{}'
# expect: 401 bad signature
```

Bearer-token check:

```bash
curl "<worker-url>/events"
# expect: 401 unauthorized
curl -H "Authorization: Bearer <BOT_POLL_TOKEN>" "<worker-url>/events"
# expect: 200 {"events":[...]}
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in
npx wrangler dev
```

`.dev.vars` is gitignored.

## Routes

| Method | Path           | Auth                          | Purpose                          |
|--------|----------------|-------------------------------|----------------------------------|
| POST   | `/gh/webhook`  | HMAC `X-Hub-Signature-256`    | GitHub webhook intake            |
| GET    | `/events`      | `Authorization: Bearer <tok>` | List queued events for the bot   |
| DELETE | `/events`      | `Authorization: Bearer <tok>` | Drain processed events by id     |

`DELETE /events` body: `{"delivery_ids": ["uuid-1", "uuid-2", ...]}`

## KV layout

| Key                                       | Value          | TTL  | Purpose         |
|-------------------------------------------|----------------|------|-----------------|
| `seen:<delivery-id>`                      | `"1"`          | 7d   | Replay dedup    |
| `queue:<iso-ts>:<delivery-id>`            | JSON record    | none | Event queue     |

Event record shape:

```json
{
  "delivery_id": "uuid",
  "event": "push",
  "action": "opened",
  "repo": "SirWhack/foo",
  "sha": "abc123",
  "branch": "main",
  "ts": "2026-05-24T12:34:56.789Z"
}
```

## Secret rotation

Quarterly, or on suspected leak:

1. Generate a new value with `openssl rand -hex 32`.
2. `wrangler secret put <NAME>` with the new value.
3. For `GITHUB_WEBHOOK_SECRET`: update the GitHub App's webhook secret in
   the UI. There's no overlap window — there will be a brief moment where
   in-flight deliveries fail; GitHub will retry, so worst case is a few
   minutes of latency.
4. For `BOT_POLL_TOKEN`: update `.env` on the bot side.
