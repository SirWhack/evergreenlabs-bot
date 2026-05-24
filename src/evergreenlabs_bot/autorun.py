"""Autonomous run: drafts, accepts, publishes — no human in the loop.

Sanity bars below filter out drafts the LLM clearly fumbled (empty content,
truncated outputs). Failures stay in the queue for manual review.
"""

from __future__ import annotations

from .config import Config
from .drafts import Draft, list_drafts, load_site_part, save_site_part
from .pipelines import introduce, log_drafter, now_updater, project_sync
from .publish import publish as do_publish
from .state import add_skip, state_conn


def _passes_sanity(d: Draft) -> tuple[bool, str]:
    p = d.payload
    if d.kind == "log_entry":
        body = (p.get("body") or "").strip()
        if len(body) < 20:
            return False, f"body too short ({len(body)} chars)"
        return True, ""
    if d.kind == "now_text":
        text = (p.get("text") or "").strip()
        if len(text) < 10:
            return False, f"text too short ({len(text)} chars)"
        return True, ""
    if d.kind == "project_intro":
        if not (p.get("blurb") or "").strip():
            return False, "empty blurb"
        return True, ""
    return False, f"unknown kind: {d.kind}"


def _apply(d: Draft, cfg: Config) -> None:
    if d.kind == "log_entry":
        log = load_site_part("log", [])
        log.insert(0, d.payload)
        save_site_part("log", log)
        # Same trigger as manual review — log acceptance refreshes now.text.
        try:
            now_updater.draft_from_log_entry(cfg, d.payload)
        except Exception:
            pass
    elif d.kind == "now_text":
        save_site_part("now", d.payload)
    elif d.kind == "project_intro":
        projects = load_site_part("projects", [])
        projects.append(d.payload)
        save_site_part("projects", projects)


def run(cfg: Config) -> dict:
    summary: dict = {
        "sync": None,
        "introduced": 0,
        "log_drafts": 0,
        "log_drafts_skipped": 0,
        "accepted": 0,
        "held_for_review": 0,
        "published": False,
    }

    # 1. Project metadata (no LLM, fully deterministic).
    summary["sync"] = project_sync.sync_projects(cfg)

    # 2. Introduce unknown public repos.
    intro_summary = introduce.run(cfg)
    summary["introduced"] = intro_summary["drafts"]

    # 3. Draft logworthy commits.
    log_summary = log_drafter.run(cfg)
    summary["log_drafts"] = log_summary["drafts"]
    summary["log_drafts_skipped"] = log_summary["skipped"]

    # 4. Walk the queue. Auto-accept everything that passes sanity; leave the
    #    rest in the queue for next manual `bot review`.
    #    Order matters: process log_entry first so each acceptance can queue a
    #    fresh now_text candidate, which we'll see on the second pass.
    for _ in range(2):
        pending = list_drafts("pending")
        if not pending:
            break
        pending.sort(key=lambda d: (d.kind != "log_entry", d.created_at))
        for d in pending:
            ok, reason = _passes_sanity(d)
            if not ok:
                # Project intros that fumbled get skiplisted so they don't
                # regenerate the same broken draft every run.
                if d.kind == "project_intro" and d.source_repo:
                    with state_conn() as conn:
                        add_skip(conn, d.source_repo, reason=f"autorun: {reason}")
                    d.delete()
                # log_entry / now_text failures stay queued for human review.
                else:
                    summary["held_for_review"] += 1
                continue
            _apply(d, cfg)
            d.delete()
            summary["accepted"] += 1

    # 5. Publish if anything changed.
    do_publish(cfg)
    summary["published"] = True
    return summary
