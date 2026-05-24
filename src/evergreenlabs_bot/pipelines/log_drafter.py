from __future__ import annotations

from datetime import datetime
from typing import Iterable

from ..config import Config
from ..drafts import load_site_part, new_draft
from ..github_client import Commit, GitHubClient
from ..llm_client import LLMClient
from ..state import get_cursor, set_cursor, state_conn


PIPELINE = "log_drafter"
SKIP_NAMES = {"evergreenlabs"}


JUDGE_SYSTEM = """\
You are filtering a developer's git commits for inclusion in a public dev log.
The log voice is terse, specific, often self-deprecating: it records what was
tried, what worked, what didn't, and the small lesson learned. Examples:
- "swapped the VLM fallback for a smaller open model. Faster and cheaper, but it
  loses small-caps as italics about a third of the time. Reverting."
- "Ported dmscreen's dice roller to WebAssembly to see if it'd be faster. It
  is not. Reverted in 20 minutes."

Logworthy commits change *behavior or approach* in a way a reader could form an
opinion about. NOT logworthy: typo fixes, formatting, dependency bumps, README
edits, merge commits, "wip" commits, vendored asset updates, generated files.
"""


JUDGE_USER_TEMPLATE = """\
Repo: {repo}
Message: {message}
Files changed ({n_files}): {files}
Diff size: +{add}/-{dele}

Decide: is this commit logworthy?
Return JSON: {{"logworthy": true|false, "reason": "<one short clause>"}}
"""


DRAFT_SYSTEM = """\
You write entries for a developer's public dev log. Voice rules:
- 1-3 short sentences. Specific over abstract.
- Lowercase commit-message-style; small inline <code>tags</code> for filenames or
  identifiers; occasional &ldquo;quote&rdquo; or &mdash;.
- Self-deprecation is fine. Avoid hype words ("excited", "powerful", "robust").
- Lead with the change; end with what it cost, what it taught, or what's next.

Output ONLY the HTML body — no surrounding tags, no leading "Today I…",
no explanations.
"""


DRAFT_USER_TEMPLATE = """\
Project: {project} (slug: {slug})
Commit message: {message}
Files: {files}
Diff: +{add}/-{dele}

Write a log entry body (HTML allowed: <code>, <b>, <i>, <a>).
"""


def _format_files(files: tuple[str, ...]) -> str:
    if not files:
        return "(none)"
    if len(files) <= 6:
        return ", ".join(files)
    return ", ".join(files[:6]) + f", … (+{len(files) - 6} more)"


def _short_date(d: datetime) -> tuple[str, str]:
    return d.strftime("%b %d").lower(), d.strftime("%Y")


def _project_slug_for_repo(repo_name: str, projects: list[dict]) -> str | None:
    rl = repo_name.lower()
    for p in projects:
        if p["slug"].lower() == rl:
            return p["slug"]
    return None


def _judge(llm: LLMClient, commit: Commit) -> tuple[bool, str]:
    try:
        result = llm.chat_json(
            JUDGE_SYSTEM,
            JUDGE_USER_TEMPLATE.format(
                repo=commit.repo,
                message=commit.message,
                n_files=len(commit.files_changed),
                files=_format_files(commit.files_changed),
                add=commit.additions,
                dele=commit.deletions,
            ),
            max_tokens=120,
        )
    except Exception as e:
        return False, f"judge failed: {e}"
    return bool(result.get("logworthy")), str(result.get("reason", ""))


def _draft_body(llm: LLMClient, commit: Commit, slug: str | None) -> str:
    result = llm.chat(
        DRAFT_SYSTEM,
        DRAFT_USER_TEMPLATE.format(
            project=commit.repo,
            slug=slug or commit.repo,
            message=commit.message,
            files=_format_files(commit.files_changed),
            add=commit.additions,
            dele=commit.deletions,
        ),
        temperature=0.5,
        max_tokens=300,
    )
    return result.text.strip()


def run(cfg: Config, *, limit_per_repo: int = 30) -> dict:
    """Walk repos, advance cursors, draft logworthy commits.

    Returns a summary dict for the CLI.
    """
    projects = load_site_part("projects", [])
    summary = {"repos_scanned": 0, "commits_seen": 0, "drafts": 0, "skipped": 0}

    llm = LLMClient(cfg)
    with GitHubClient(cfg) as gh, state_conn() as conn:
        repos = gh.list_public_repos()
        for repo in repos:
            if repo.archived or repo.fork or repo.name in SKIP_NAMES:
                continue
            summary["repos_scanned"] += 1
            cursor = get_cursor(conn, repo.name, PIPELINE)
            commits = gh.commits_since(repo, cursor)[:limit_per_repo]
            for commit in commits:
                summary["commits_seen"] += 1
                logworthy, reason = _judge(llm, commit)
                if not logworthy:
                    summary["skipped"] += 1
                    set_cursor(conn, repo.name, PIPELINE, commit.sha)
                    continue
                slug = _project_slug_for_repo(repo.name, projects)
                body = _draft_body(llm, commit, slug)
                date_str, year_str = _short_date(commit.date)
                payload = {
                    "date": date_str,
                    "year": year_str,
                    "body": body,
                    "project": slug,
                }
                draft = new_draft(
                    kind="log_entry",
                    payload=payload,
                    source_commits=[commit.sha],
                    source_repo=repo.name,
                )
                draft.notes = f"judge: {reason}"
                draft.save()
                summary["drafts"] += 1
                set_cursor(conn, repo.name, PIPELINE, commit.sha)
    return summary
