import { verifyGitHubSignature } from "./verify";
import { deleteEvents, enqueue, isSeen, listEvents, markSeen } from "./store";
import { extractRecord, shouldEnqueue } from "./filter";

export interface Env {
  EVENTS: KVNamespace;
  GITHUB_WEBHOOK_SECRET: string;
  BOT_POLL_TOKEN: string;
  GITHUB_USERNAME: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/gh/webhook") {
      return handleWebhook(req, env);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      return handleListEvents(req, env);
    }
    if (req.method === "DELETE" && url.pathname === "/events") {
      return handleDeleteEvents(req, env);
    }
    return new Response("not found", { status: 404 });
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

  if (await isSeen(env.EVENTS, deliveryId)) {
    return new Response("already processed", { status: 200 });
  }
  await markSeen(env.EVENTS, deliveryId);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  if (!shouldEnqueue(event, payload, env.GITHUB_USERNAME)) {
    return new Response("filtered", { status: 200 });
  }

  await enqueue(env.EVENTS, extractRecord(event, payload, deliveryId));
  return new Response("queued", { status: 200 });
}

async function handleListEvents(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env.BOT_POLL_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  const events = await listEvents(env.EVENTS);
  return json({ events });
}

async function handleDeleteEvents(req: Request, env: Env): Promise<Response> {
  if (!bearerOk(req, env.BOT_POLL_TOKEN)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: { delivery_ids?: string[] };
  try {
    body = (await req.json()) as { delivery_ids?: string[] };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const deleted = await deleteEvents(env.EVENTS, body.delivery_ids ?? []);
  return json({ deleted });
}

function bearerOk(req: Request, expected: string): boolean {
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
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
