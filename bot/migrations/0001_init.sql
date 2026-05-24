-- ADR-0001 §D2 — D1 schema for evergreenlabs-bot.
-- All JSON blobs are stored as TEXT; D1 does not have a JSON column type but
-- the runtime parses with JSON.parse() at read time. All timestamps are UNIX
-- epoch seconds (INTEGER) — matches Workers `Math.floor(Date.now() / 1000)`.

-- Rendered site parts. The published siteData.js is composed by re-rendering
-- the union of these rows; each `name` corresponds to a top-level key the
-- website's renderer expects (profile, now, projects, contributions, roadmap,
-- log). Slice 1 also writes a `tracer` row to prove the spine is alive.
CREATE TABLE IF NOT EXISTS site_parts (
  name        TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- LLM-drafted content awaiting auto-accept or human review. `source_commits`
-- is a JSON array of SHAs used as input.
CREATE TABLE IF NOT EXISTS drafts (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  source_repo     TEXT,
  source_commits  TEXT,
  status          TEXT NOT NULL,
  notes           TEXT,
  created_at      INTEGER NOT NULL
);

-- Repos that should be skipped by the per-repo pipeline (archived, fork-only,
-- explicit opt-out, etc).
CREATE TABLE IF NOT EXISTS skipped_repos (
  repo        TEXT PRIMARY KEY,
  reason      TEXT,
  skipped_at  INTEGER NOT NULL
);

-- Backstop SHA cursor per (repo, pipeline). Webhook payloads carry before/after
-- SHAs; this table covers the cron path where there is no payload.
CREATE TABLE IF NOT EXISTS cursors (
  repo        TEXT NOT NULL,
  pipeline    TEXT NOT NULL,
  last_sha    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, pipeline)
);

-- Webhook replay protection. Pruned periodically by TTL (~7d).
CREATE TABLE IF NOT EXISTS webhook_dedup (
  delivery_id  TEXT PRIMARY KEY,
  seen_at      INTEGER NOT NULL
);

-- Index supports the TTL prune scan.
CREATE INDEX IF NOT EXISTS idx_webhook_dedup_seen_at
  ON webhook_dedup(seen_at);
