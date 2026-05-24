// Minimal D1 wrapper used by the Slice 1 tracer. Later slices add
// helpers for drafts/, cursors/, skipped_repos/ alongside these.

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
