-- Slice 2 — per-repo debounce queue. The webhook handler inserts a row per
-- delivery; the PerRepoUpdate Workflow drains rows for its repo after the
-- debounce sleep. delivery_id is globally unique (GitHub guarantees) so it
-- doubles as a natural dedup key against double-enqueue races.

CREATE TABLE IF NOT EXISTS pending_events (
  repo         TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, delivery_id)
);

-- Drain scan is per-repo, ordered by received_at.
CREATE INDEX IF NOT EXISTS idx_pending_events_repo_received_at
  ON pending_events(repo, received_at);
