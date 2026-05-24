from __future__ import annotations

from ..config import Config
from ..drafts import load_site_part, new_draft
from ..github_client import GitHubClient, Repo
from ..llm_client import LLMClient
from ..state import is_skipped, state_conn


SKIP_NAMES = {"evergreenlabs"}


def _sluggify(name: str) -> str:
    """Repo names can contain anything; slugs must be kebab-case for URLs/assets."""
    import re
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-") or "project"


BLURB_SYSTEM = """\
You write one-sentence project blurbs for a developer's personal site.
Voice: lowercase, terse, specific. Mentions what the project does, not why.
No hype words (powerful, robust, excited). No first-person.

Examples of the voice:
- "Extracts structured markdown from academic and legal PDFs. Multi-column reading order, tables, footnotes, citations."
- "A single-page DM screen for D&D 5e — initiative, conditions, concentration, monster lookup. Works offline."

Output ONLY the blurb. No quotes, no prose around it.
If the inputs are too thin to write something honest, output an empty string.
"""


BLURB_USER_TEMPLATE = """\
Repo: {name}
Language: {language}
Topics: {topics}
GitHub description: {description}

README (first ~400 chars):
{readme}

Write the blurb (1-2 short sentences, or empty if you don't have enough).
"""


def _readme_excerpt(text: str | None, n: int = 400) -> str:
    if not text:
        return "(no README)"
    # Trim YAML/HTML front matter and image lines; keep first prose chunk.
    lines = [
        ln for ln in text.splitlines()
        if ln.strip() and not ln.lstrip().startswith(("#", "![", "<!--"))
    ]
    body = " ".join(lines)
    return body[:n] + ("…" if len(body) > n else "")


def _normalize_tags(repo: Repo) -> list[str]:
    out = [t.upper().replace("-", " ") for t in repo.topics[:4]]
    if not out and repo.language:
        out = [repo.language.upper()]
    return out


def _meta_string(repo: Repo) -> str:
    month = repo.pushed_at.strftime("%b").lower()
    return f"updated {month} {repo.pushed_at.year}"


def _draft_blurb(llm: LLMClient, repo: Repo, readme: str | None) -> str:
    user = BLURB_USER_TEMPLATE.format(
        name=repo.name,
        language=repo.language or "(unknown)",
        topics=", ".join(repo.topics) or "(none)",
        description=repo.description or "(none)",
        readme=_readme_excerpt(readme),
    )
    try:
        result = llm.chat(BLURB_SYSTEM, user, temperature=0.4, max_tokens=200)
    except Exception:
        return ""
    return result.text.strip().strip('"').strip()


def run(cfg: Config) -> dict:
    summary = {"scanned": 0, "known": 0, "skipped": 0, "drafts": 0}
    existing = load_site_part("projects", [])
    known_slugs = {p["slug"].lower() for p in existing}
    next_idx = max((p.get("idx", 0) for p in existing), default=0) + 1

    llm = LLMClient(cfg)
    with GitHubClient(cfg) as gh, state_conn() as conn:
        for repo in gh.list_public_repos():
            if repo.archived or repo.fork or repo.name in SKIP_NAMES:
                continue
            summary["scanned"] += 1
            slug = _sluggify(repo.name)
            if slug in known_slugs:
                summary["known"] += 1
                continue
            if is_skipped(conn, repo.name):
                summary["skipped"] += 1
                continue
            readme = gh.fetch_readme(repo)
            blurb = _draft_blurb(llm, repo, readme)
            payload = {
                "idx": next_idx,
                "slug": slug,
                "title": repo.name,
                "blurb": blurb,
                "longBlurb": "",
                "writeup": "",
                "tags": _normalize_tags(repo),
                "meta": _meta_string(repo),
                "stack": repo.language or "",
                "status": "active",
                "featured": False,
                "screenshot": "",
                "links": {"repo": repo.html_url, "demo": "", "writeup": ""},
            }
            draft = new_draft(
                kind="project_intro",
                payload=payload,
                source_repo=repo.name,
            )
            draft.notes = repo.description or ""
            draft.save()
            summary["drafts"] += 1
            next_idx += 1
    return summary
