from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterator

import httpx

from .config import Config

GITHUB_API = "https://api.github.com"


class GitHubError(RuntimeError):
    pass


def _check(r: httpx.Response) -> None:
    if r.is_success:
        return
    try:
        msg = r.json().get("message", "")
    except Exception:
        msg = r.text[:200]
    if r.status_code == 401:
        raise GitHubError(
            "GitHub rejected the token (401 Bad credentials). "
            "Either fix GITHUB_TOKEN in .env or leave it blank — public repo "
            "reads work unauthenticated (lower rate limit). "
            f"GitHub said: {msg!r}"
        )
    if r.status_code == 403 and "rate limit" in msg.lower():
        raise GitHubError(
            "Hit GitHub's unauthenticated rate limit. Set GITHUB_TOKEN in .env "
            "to lift it to 5000/hr."
        )
    if r.status_code == 404:
        raise GitHubError(f"GitHub 404: {r.request.url} — {msg}")
    raise GitHubError(f"GitHub {r.status_code} on {r.request.url}: {msg}")


@dataclass(frozen=True)
class Repo:
    name: str
    full_name: str
    description: str | None
    html_url: str
    default_branch: str
    pushed_at: datetime
    archived: bool
    fork: bool
    language: str | None
    topics: tuple[str, ...]


@dataclass(frozen=True)
class Commit:
    sha: str
    repo: str
    message: str
    author: str
    date: datetime
    url: str
    files_changed: tuple[str, ...]
    additions: int
    deletions: int


class GitHubClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "evergreenlabs-bot",
        }
        if cfg.github_token:
            headers["Authorization"] = f"Bearer {cfg.github_token}"
        self.client = httpx.Client(headers=headers, timeout=30.0)

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "GitHubClient":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _paged(self, url: str, params: dict | None = None) -> Iterator[dict]:
        params = dict(params or {})
        params.setdefault("per_page", 100)
        while url:
            r = self.client.get(url, params=params)
            _check(r)
            for item in r.json():
                yield item
            url = r.links.get("next", {}).get("url", "")
            params = None  # next URL already has them baked in

    def list_public_repos(self) -> list[Repo]:
        url = f"{GITHUB_API}/users/{self.cfg.github_username}/repos"
        out: list[Repo] = []
        for raw in self._paged(url, {"type": "owner", "sort": "pushed"}):
            out.append(
                Repo(
                    name=raw["name"],
                    full_name=raw["full_name"],
                    description=raw.get("description"),
                    html_url=raw["html_url"],
                    default_branch=raw.get("default_branch", "main"),
                    pushed_at=datetime.fromisoformat(
                        raw["pushed_at"].replace("Z", "+00:00")
                    ),
                    archived=bool(raw.get("archived")),
                    fork=bool(raw.get("fork")),
                    language=raw.get("language"),
                    topics=tuple(raw.get("topics", []) or []),
                )
            )
        return out

    def fetch_readme(self, repo: Repo) -> str | None:
        url = f"{GITHUB_API}/repos/{repo.full_name}/readme"
        r = self.client.get(url, headers={"Accept": "application/vnd.github.raw"})
        if r.status_code == 404:
            return None
        _check(r)
        return r.text

    def commits_since(self, repo: Repo, since_sha: str | None) -> list[Commit]:
        """Return commits on the default branch newer than since_sha (exclusive).

        If since_sha is None, returns the most recent 30 commits as a seed window.
        Order: oldest-first (so callers can advance the cursor as they go).
        """
        list_url = f"{GITHUB_API}/repos/{repo.full_name}/commits"
        params: dict = {"sha": repo.default_branch, "per_page": 100}
        raw_commits: list[dict] = []
        if since_sha is None:
            r = self.client.get(list_url, params={**params, "per_page": 30})
            _check(r)
            raw_commits = r.json()
        else:
            for raw in self._paged(list_url, params):
                if raw["sha"] == since_sha:
                    break
                raw_commits.append(raw)

        out: list[Commit] = []
        for raw in reversed(raw_commits):
            detail = self._commit_detail(repo, raw["sha"])
            out.append(detail)
        return out

    def _commit_detail(self, repo: Repo, sha: str) -> Commit:
        r = self.client.get(f"{GITHUB_API}/repos/{repo.full_name}/commits/{sha}")
        _check(r)
        raw = r.json()
        files = tuple(f["filename"] for f in raw.get("files", [])[:50])
        stats = raw.get("stats", {}) or {}
        author_obj = raw.get("author") or {}
        commit_obj = raw.get("commit", {}) or {}
        author_name = (
            author_obj.get("login")
            or commit_obj.get("author", {}).get("name")
            or "unknown"
        )
        date_str = commit_obj.get("author", {}).get("date") or commit_obj.get(
            "committer", {}
        ).get("date")
        return Commit(
            sha=raw["sha"],
            repo=repo.name,
            message=commit_obj.get("message", "").strip(),
            author=author_name,
            date=datetime.fromisoformat(date_str.replace("Z", "+00:00")),
            url=raw["html_url"],
            files_changed=files,
            additions=int(stats.get("additions", 0)),
            deletions=int(stats.get("deletions", 0)),
        )
