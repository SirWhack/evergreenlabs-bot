from __future__ import annotations

from datetime import datetime

from ..config import Config
from ..drafts import load_site_part, new_draft
from ..github_client import GitHubClient
from ..llm_client import LLMClient


SYSTEM = """\
You are drafting a one-line "what I'm working on this week" status for a
developer's public site. Voice: terse, specific, present-tense, lowercase.
Mentions a project by name with <b>bold</b>. Optionally adds one sentence about
the current obstacle. No hype words. 1-2 sentences total, < 240 chars.

Output only the HTML body. No prose around it.
"""


USER_TEMPLATE = """\
Most recently touched project: {project}
Last commit message: {message}
Project blurb: {blurb}

Write the now.text body.
"""


SKIP_NAMES = {"evergreenlabs"}


def run(cfg: Config) -> bool:
    """Draft a now.text update from the most recently touched repo."""
    llm = LLMClient(cfg)
    with GitHubClient(cfg) as gh:
        repos = gh.list_public_repos()
        candidates = [r for r in repos if not r.archived and not r.fork and r.name not in SKIP_NAMES]
        if not candidates:
            return False
        top = max(candidates, key=lambda r: r.pushed_at)
        commits = gh.commits_since(top, None)
        if not commits:
            return False
        latest = commits[-1]

    projects = load_site_part("projects", [])
    blurb = next(
        (p.get("blurb", "") for p in projects if p["slug"].lower() == top.name.lower()),
        top.description or "",
    )
    result = llm.chat(
        SYSTEM,
        USER_TEMPLATE.format(
            project=top.name,
            message=latest.message,
            blurb=blurb,
        ),
        temperature=0.5,
        max_tokens=200,
    )
    week_of = datetime.utcnow().strftime("%b %d").lower()
    payload = {"weekOf": week_of, "text": result.text.strip()}
    draft = new_draft(
        kind="now_text",
        payload=payload,
        source_commits=[latest.sha],
        source_repo=top.name,
    )
    draft.save()
    return True
