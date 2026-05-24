from __future__ import annotations

from datetime import datetime

from ..config import Config
from ..drafts import load_site_part, save_site_part
from ..github_client import GitHubClient, Repo
from ..state import is_skipped, state_conn


SKIP_NAMES = {"evergreenlabs", "evergreenlabs-bot"}


def _meta_string(repo: Repo) -> str:
    month = repo.pushed_at.strftime("%b").lower()
    year = repo.pushed_at.year
    return f"updated {month} {year}"


def _normalize_topics(topics: tuple[str, ...]) -> list[str]:
    return [t.upper().replace("-", " ") for t in topics[:4]]


def _short_blurb(description: str | None) -> str:
    if not description:
        return ""
    return description.strip()


def sync_projects(cfg: Config) -> dict:
    """Refresh projects[] with metadata pulled live from GitHub.

    Preserves longBlurb, writeup, and screenshot (the hand-written parts).
    Auto-refreshes: meta date, stack hints (language), tags (topics), repo link,
    blurb (if currently empty). Does not add new projects automatically — that
    requires `bot introduce` for a review-gated draft.
    """
    existing = load_site_part("projects", [])
    by_slug = {p["slug"]: p for p in existing}

    summary = {"scanned": 0, "matched": 0, "updated": 0, "unintroduced": 0, "skiplisted": 0}
    with GitHubClient(cfg) as gh, state_conn() as conn:
        repos = gh.list_public_repos()
        for repo in repos:
            if repo.archived or repo.fork or repo.name in SKIP_NAMES:
                continue
            summary["scanned"] += 1
            slug = repo.name.lower()
            if slug not in by_slug:
                if is_skipped(conn, repo.name):
                    summary["skiplisted"] += 1
                else:
                    summary["unintroduced"] += 1
                continue
            summary["matched"] += 1
            entry = by_slug[slug]
            before = dict(entry)
            entry["links"] = entry.get("links", {}) or {}
            if not entry["links"].get("repo"):
                entry["links"]["repo"] = repo.html_url
            entry["meta"] = _meta_string(repo)
            topics = _normalize_topics(repo.topics)
            if topics:
                entry["tags"] = topics
            if repo.language and (
                not entry.get("stack") or entry["stack"].strip() == ""
            ):
                entry["stack"] = repo.language
            if not entry.get("blurb"):
                entry["blurb"] = _short_blurb(repo.description)
            if entry != before:
                summary["updated"] += 1

    save_site_part("projects", list(by_slug.values()))
    return summary
