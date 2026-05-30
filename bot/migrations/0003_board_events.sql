-- ADR-0003 — lifecycle timeline for board items. One row per Status
-- transition, regardless of which direction drove it (MCP update_item,
-- an `issues` webhook reconcile, or the daily sweep). Gives the board a
-- queryable history and a hook for downstream automation: a transition
-- into a terminal status ("Done") is the natural trigger to feed the site
-- log / "now" text.
--
-- Rows are append-only; we never update or delete. `from_status` is null
-- for the first observation of an item (fresh ingest).

CREATE TABLE IF NOT EXISTS board_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL,
  repo          TEXT,
  issue_number  INTEGER,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  at            INTEGER NOT NULL
);

-- Per-item history scan, newest first.
CREATE INDEX IF NOT EXISTS idx_board_events_item_at
  ON board_events(item_id, at);

-- Cross-repo "what changed recently" scan (e.g. weekly shipped digest).
CREATE INDEX IF NOT EXISTS idx_board_events_repo_at
  ON board_events(repo, at);
