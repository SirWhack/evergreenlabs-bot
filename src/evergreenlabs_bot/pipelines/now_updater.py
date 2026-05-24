from __future__ import annotations

from datetime import datetime

from ..config import Config
from ..drafts import list_drafts, load_site_part, new_draft
from ..github_client import GitHubClient
from ..llm_client import LLMClient


SYSTEM = """\
You are drafting a one-line "what I'm working on this week" status for a
developer's public site. Voice: terse, specific, present-tense, lowercase.
Mentions a project by name with <b>bold</b>. Optionally adds one sentence about
the current obstacle. No hype words. 1-2 sentences total, < 240 chars.

Output only the HTML body. No prose around it.
"""


COMMIT_USER_TEMPLATE = """\
Most recently touched project: {project}
Last commit message: {message}
Project blurb: {blurb}

Write the now.text body.
"""


LOG_USER_TEMPLATE = """\
The user just accepted a log entry. Forward-rephrase it as a "currently
working on" status — same project, present tense, looking ahead at the next
step. Do NOT quote the log entry verbatim.

Project: {project_title}
Project blurb: {blurb}
Log entry body: {body}

Write the now.text body.
"""


SKIP_NAMES = {"evergreenlabs"}


def _supersede_pending_now_drafts() -> int:
    """Delete any pending now_text drafts. Returns the count removed."""
    removed = 0
    for d in list_drafts("pending"):
        if d.kind == "now_text":
            d.delete()
            removed += 1
    return removed


def draft_from_log_entry(cfg: Config, log_entry: dict) -> bool:
    """Draft a now.text candidate from a freshly-accepted log entry.

    Supersedes any pending now_text drafts (only one current candidate at a time).
    Returns True if a draft was created.
    """
    slug = log_entry.get("project")
    if not slug:
        return False
    projects = load_site_part("projects", [])
    project = next((p for p in projects if p["slug"] == slug), None)
    title = project["title"] if project else slug
    blurb = project.get("blurb", "") if project else ""

    llm = LLMClient(cfg)
    try:
        result = llm.chat(
            SYSTEM,
            LOG_USER_TEMPLATE.format(
                project_title=title,
                blurb=blurb or "(none)",
                body=log_entry.get("body", ""),
            ),
            temperature=0.5,
            max_tokens=200,
        )
    except Exception:
        return False

    _supersede_pending_now_drafts()
    payload = {
        "weekOf": datetime.utcnow().strftime("%b %d").lower(),
        "text": result.text.strip(),
    }
    draft = new_draft(
        kind="now_text",
        payload=payload,
        source_repo=slug,
    )
    draft.notes = f"derived from log entry: {log_entry.get('date','')} {log_entry.get('year','')}"
    draft.save()
    return True


def run(cfg: Config) -> bool:
    """Draft a now.text candidate from the most recent log entry.

    Falls back to the most recently touched repo when log.json is empty. Used by
    `bot catch-up` for the case where the log has new content from a fresh
    review session but no log was accepted in this session.
    """
    log = load_site_part("log", [])
    if log:
        return draft_from_log_entry(cfg, log[0])
    return _draft_from_latest_commit(cfg)


def _draft_from_latest_commit(cfg: Config) -> bool:
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
    try:
        result = llm.chat(
            SYSTEM,
            COMMIT_USER_TEMPLATE.format(
                project=top.name,
                message=latest.message,
                blurb=blurb,
            ),
            temperature=0.5,
            max_tokens=200,
        )
    except Exception:
        return False
    _supersede_pending_now_drafts()
    payload = {
        "weekOf": datetime.utcnow().strftime("%b %d").lower(),
        "text": result.text.strip(),
    }
    draft = new_draft(
        kind="now_text",
        payload=payload,
        source_commits=[latest.sha],
        source_repo=top.name,
    )
    draft.save()
    return True
