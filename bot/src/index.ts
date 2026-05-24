// Worker entrypoint. Handles GitHub webhook intake, manual daily-sync
// trigger, and a health probe. All multi-step work is delegated to
// Workflows (see src/workflows/), per ADR-0001.

import { verifyGitHubSignature } from "./lib/verify";
import { shouldEnqueue } from "./lib/filter";
import { enqueuePendingEvent, seenDelivery } from "./lib/state";

// Re-exports so wrangler can register the Workflow classes against this
// Worker script (see [[workflows]] bindings in wrangler.toml).
export { PerRepoUpdate } from "./workflows/per-repo";
export { DailySync } from "./workflows/daily-sync";

export interface Env {
  DB: D1Database;
  PER_REPO_UPDATE: Workflow;
  DAILY_SYNC: Workflow;

  // Secrets
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  OPENROUTER_API_KEY: string;
  TRIGGER_TOKEN: string;

  // Vars
  GITHUB_USERNAME: string;
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
  LLM_MODEL: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (req.method === "POST" && url.pathname === "/gh/webhook") {
      return handleWebhook(req, env);
    }
    if (req.method === "POST" && url.pathname === "/trigger/daily-sync") {
      return handleManualDailySync(req, env);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Daily 03:00 UTC cron — see [triggers] in wrangler.toml.
    await env.DAILY_SYNC.create({ params: { source: "cron" } });
  },
};

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get("X-Hub-Signature-256");
  const deliveryId = req.headers.get("X-GitHub-Delivery");
  const event = req.headers.get("X-GitHub-Event");
  if (!sig || !deliveryId || !event) {
    return new Response("missing headers", { status: 400 });
  }

  const rawBody = await req.text();
  const ok = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, sig);
  if (!ok) {
    return new Response("bad signature", { status: 401 });
  }

  // Atomic dedup: returns true if this delivery was already recorded.
  if (await seenDelivery(env.DB, deliveryId)) {
    return new Response(null, { status: 204 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (!shouldEnqueue(event, payload, env.GITHUB_USERNAME)) {
    return new Response(null, { status: 204 });
  }

  const repoFullName: string | undefined = payload?.repository?.full_name;
  if (!repoFullName) {
    return new Response(null, { status: 204 });
  }

  // Always record the raw event in pending_events FIRST. This is the queue
  // the per-repo Workflow drains after its debounce sleep. Coalescing comes
  // from this queue, NOT from Workflow instance id uniqueness — Cloudflare
  // Workflows refuse to reuse an instance id within the retention window
  // (~days), so a deterministic per-repo id would self-immolate after the
  // first push. Instead, every webhook creates a fresh instance with a
  // unique id; each instance sleeps DEBOUNCE_SECONDS and then drains
  // pending_events for its repo. The first instance to drain wins; later
  // instances find an empty queue and exit cheaply.
  await enqueuePendingEvent(env.DB, repoFullName, deliveryId, event, payload);

  // Unique instance id per delivery. Delivery IDs are guaranteed unique by
  // GitHub. Sanitize underscore for readability — Workflows accept the raw
  // value but it's nicer in `wrangler workflows instances list`.
  const sanitizedRepo = repoFullName.replace(/\//g, "__");
  const instanceId = `${sanitizedRepo}__${deliveryId}`;
  await env.PER_REPO_UPDATE.create({
    id: instanceId,
    params: { repo: repoFullName, delivery_id: deliveryId, event },
  });

  return new Response(null, { status: 204 });
}

async function handleManualDailySync(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env.TRIGGER_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  const instance = await env.DAILY_SYNC.create({ params: { source: "manual" } });
  return json({ id: instance.id }, 202);
}

function bearerOk(req: Request, expected: string): boolean {
  const auth = req.headers.get("Authorization");
  if (!auth || !expected) return false;
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  return timingSafeEqual(m[1], expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
