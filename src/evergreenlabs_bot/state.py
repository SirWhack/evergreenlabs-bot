from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import STATE_DB


SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (
    repo        TEXT NOT NULL,
    pipeline    TEXT NOT NULL,
    last_sha    TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (repo, pipeline)
);

CREATE TABLE IF NOT EXISTS published_log (
    log_id      TEXT PRIMARY KEY,
    source_sha  TEXT,
    published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skipped_repos (
    repo        TEXT PRIMARY KEY,
    reason      TEXT,
    skipped_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _connect(path: Path = STATE_DB) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def state_conn(path: Path = STATE_DB) -> Iterator[sqlite3.Connection]:
    conn = _connect(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def get_cursor(conn: sqlite3.Connection, repo: str, pipeline: str) -> str | None:
    row = conn.execute(
        "SELECT last_sha FROM cursors WHERE repo = ? AND pipeline = ?",
        (repo, pipeline),
    ).fetchone()
    return row["last_sha"] if row else None


def set_cursor(
    conn: sqlite3.Connection, repo: str, pipeline: str, sha: str
) -> None:
    conn.execute(
        """
        INSERT INTO cursors (repo, pipeline, last_sha) VALUES (?, ?, ?)
        ON CONFLICT(repo, pipeline) DO UPDATE SET
            last_sha = excluded.last_sha,
            updated_at = datetime('now')
        """,
        (repo, pipeline, sha),
    )


def add_skip(conn: sqlite3.Connection, repo: str, reason: str = "") -> None:
    conn.execute(
        """
        INSERT INTO skipped_repos (repo, reason) VALUES (?, ?)
        ON CONFLICT(repo) DO UPDATE SET reason = excluded.reason
        """,
        (repo, reason),
    )


def is_skipped(conn: sqlite3.Connection, repo: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM skipped_repos WHERE repo = ?", (repo,)
    ).fetchone()
    return row is not None


def list_skips(conn: sqlite3.Connection) -> list[str]:
    return [r["repo"] for r in conn.execute("SELECT repo FROM skipped_repos ORDER BY repo")]
