// D1 wrappers. Slice 1 had site_parts + webhook_dedup helpers; Slice 2 adds
// drafts, cursors, and pending_events used by the log_drafter pipeline +
// per-repo debounce.

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Read a single site_parts row. Returns parsed JSON payload or null. */
export async function getSitePart<T = unknown>(
  db: D1Database,
  name: string,
): Promise<T | null> {
  const row = await db
    .prepare("SELECT payload FROM site_parts WHERE name = ?1")
    .bind(name)
    .first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

/** Upsert a site_parts row with the given JSON-serializable payload. */
export async function putSitePart(
  db: D1Database,
  name: string,
  payload: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_parts (name, payload, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
    )
    .bind(name, JSON.stringify(payload), nowSeconds())
    .run();
}

/**
 * Returns true if `repo` (by short name) is in the `skipped_repos` table.
 * Mirrors the Python `state.is_skipped(conn, repo)`.
 */
export async function isSkipped(db: D1Database, repo: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM skipped_repos WHERE repo = ?1")
    .bind(repo)
    .first<{ one: number }>();
  return row !== null;
}

/**
 * Atomically record a webhook delivery id in `webhook_dedup`.
 *
 * Returns `true` if the delivery was already seen (and the caller should
 * short-circuit), `false` if this is the first time we've seen it.
 *
 * Uses `INSERT OR IGNORE` + meta.changes so the read+write race is closed
 * by SQLite itself rather than by a SELECT-then-INSERT pattern.
 */
export async function seenDelivery(
  db: D1Database,
  deliveryId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_dedup (delivery_id, seen_at)
       VALUES (?1, ?2)`,
    )
    .bind(deliveryId, nowSeconds())
    .run();
  // meta.changes === 0 means the row already existed (insert ignored).
  return (result.meta?.changes ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

export type DraftStatus = "pending" | "accepted" | "held_for_review";

export interface DraftRow {
  id: string;
  kind: string;
  payload: unknown;
  source_repo: string | null;
  source_commits: string[];
  status: DraftStatus;
  notes: string | null;
  created_at: number;
}

export interface InsertDraftArgs {
  id: string;
  kind: string;
  /** JSON-serializable payload; shape depends on `kind`. */
  payload: unknown;
  source_repo: string | null;
  source_commits: string[];
  status: DraftStatus;
  notes?: string | null;
}

/** Insert a new draft row. Caller supplies the id (uuid-ish) and status. */
export async function insertDraft(
  db: D1Database,
  args: InsertDraftArgs,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO drafts (id, kind, payload, source_repo, source_commits, status, notes, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      args.id,
      args.kind,
      JSON.stringify(args.payload),
      args.source_repo,
      JSON.stringify(args.source_commits),
      args.status,
      args.notes ?? null,
      nowSeconds(),
    )
    .run();
}

// ---------------------------------------------------------------------------
// cursors
// ---------------------------------------------------------------------------

/** Return the last processed SHA for (repo, pipeline) or null. */
export async function getCursor(
  db: D1Database,
  repo: string,
  pipeline: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT last_sha FROM cursors WHERE repo = ?1 AND pipeline = ?2`,
    )
    .bind(repo, pipeline)
    .first<{ last_sha: string }>();
  return row?.last_sha ?? null;
}

/** Upsert the cursor for (repo, pipeline). */
export async function setCursor(
  db: D1Database,
  repo: string,
  pipeline: string,
  sha: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cursors (repo, pipeline, last_sha, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(repo, pipeline) DO UPDATE SET
         last_sha = excluded.last_sha,
         updated_at = excluded.updated_at`,
    )
    .bind(repo, pipeline, sha, nowSeconds())
    .run();
}

// ---------------------------------------------------------------------------
// pending_events — per-repo debounce queue. The webhook handler enqueues
// raw push payloads here; the per-repo Workflow drains them after its sleep.
// Coalescing is implicit: a Workflow instance is singleton per repo, so any
// number of pushes that land while one is sleeping all get drained together.
// ---------------------------------------------------------------------------

/**
 * JSON-serializable wrapper. Workflows `step.do` requires serializable
 * return values (no functions, no class instances, no Dates). Using `unknown`
 * here keeps the type compatible with that constraint without losing the
 * "this came from JSON" signal at callsites.
 */
export type PendingEventPayload = unknown;

export interface PendingEvent {
  delivery_id: string;
  event: string;
  payload: PendingEventPayload;
  received_at: number;
}

/**
 * Enqueue a raw webhook event for `repo`. Idempotent on delivery_id (we
 * already dedup at the Worker, but this protects against double-write
 * if a retry races a Workflow drain).
 */
export async function enqueuePendingEvent(
  db: D1Database,
  repo: string,
  delivery_id: string,
  event: string,
  payload: unknown,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pending_events (repo, delivery_id, event, payload, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(repo, delivery_id, event, JSON.stringify(payload), nowSeconds())
    .run();
}

/**
 * Drain all pending events for `repo` in receive order, deleting the rows.
 * Caller treats failure to process as a retry signal — the Workflow step
 * boundary handles that.
 *
 * Returns events with their raw GitHub payloads parsed back out.
 */
export async function drainPendingEvents(
  db: D1Database,
  repo: string,
): Promise<PendingEvent[]> {
  const rows = await db
    .prepare(
      `SELECT delivery_id, event, payload, received_at
       FROM pending_events
       WHERE repo = ?1
       ORDER BY received_at ASC`,
    )
    .bind(repo)
    .all<{
      delivery_id: string;
      event: string;
      payload: string;
      received_at: number;
    }>();
  const events = (rows.results ?? []).map((r) => ({
    delivery_id: r.delivery_id,
    event: r.event,
    payload: safeParse(r.payload),
    received_at: r.received_at,
  }));
  if (events.length === 0) return [];
  // Delete in one shot — we own these rows now. If we crash before processing,
  // the Workflow step retry sees an empty drain on next attempt, which is the
  // correct semantic (the webhook_dedup row prevents the event ever coming
  // back). Acceptable risk for v1.
  const placeholders = events.map((_, i) => `?${i + 2}`).join(",");
  await db
    .prepare(
      `DELETE FROM pending_events WHERE repo = ?1 AND delivery_id IN (${placeholders})`,
    )
    .bind(repo, ...events.map((e) => e.delivery_id))
    .run();
  return events;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
