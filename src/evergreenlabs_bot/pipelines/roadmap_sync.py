"""Sync the website's roadmap from a GitHub Projects v2 board.

Auto-syncs (no review queue) — the Project board is already the user's curated
truth. Drops items with status='Done' (those belong in the log via log_drafter).
Per-item LLM commentary is cached against (id, updatedAt) so unchanged items
don't burn tokens.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ..config import DATA_DIR, Config
from ..drafts import save_site_part
from ..github_projects import RoadmapItem, fetch_project_items
from ..llm_client import LLMClient


CACHE_PATH = DATA_DIR / "cache" / "roadmap-commentary.json"

HIDDEN_STATUSES = {"done", "closed", "shipped", "archived"}


COMMENTARY_SYSTEM = """\
You write one-line context blurbs for items on a developer's public roadmap.
Voice: terse, lowercase, specific. NO hype words (powerful, robust, exciting).
NO meta phrases ("this card", "this item"). State what the change does and the
shape of the work, nothing more. 1 short sentence, < 140 chars.

Output ONLY the sentence. If the inputs are too thin, output an empty string.
"""


COMMENTARY_USER_TEMPLATE = """\
Title: {title}
Status: {status}
Kind: {kind}
Body:
{body}

Write the one-line context blurb.
"""


def _load_cache() -> dict[str, dict]:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text())
    except Exception:
        return {}


def _save_cache(cache: dict[str, dict]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False))


def _draft_commentary(llm: LLMClient, item: RoadmapItem) -> str:
    body_excerpt = item.body[:600]
    try:
        result = llm.chat(
            COMMENTARY_SYSTEM,
            COMMENTARY_USER_TEMPLATE.format(
                title=item.title,
                status=item.status or "(none)",
                kind=item.kind or "(none)",
                body=body_excerpt or "(empty)",
            ),
            temperature=0.3,
            max_tokens=160,
        )
    except Exception:
        return ""
    return result.text.strip().strip('"').strip()


def _normalize(item: RoadmapItem, commentary: str) -> dict:
    return {
        "id": item.id,
        "title": item.title,
        "status": item.status or "Untriaged",
        "priority": item.priority,
        "kind": item.kind,
        "url": item.url,
        "repo": item.repo,
        "isDraft": item.is_draft,
        "commentary": commentary,
        "updatedAt": item.updated_at.astimezone(timezone.utc).isoformat(),
    }


def run(cfg: Config, *, with_commentary: bool = True) -> dict:
    summary = {"fetched": 0, "kept": 0, "hidden_done": 0, "commentary_new": 0, "commentary_cached": 0}

    if cfg.github_project_number is None:
        save_site_part("roadmap", [])
        summary["note"] = "GITHUB_PROJECT_NUMBER not set; cleared roadmap"
        return summary

    items = fetch_project_items(cfg)
    summary["fetched"] = len(items)

    cache = _load_cache() if with_commentary else {}
    llm = LLMClient(cfg) if with_commentary else None

    out: list[dict] = []
    for item in items:
        if (item.status or "").strip().lower() in HIDDEN_STATUSES:
            summary["hidden_done"] += 1
            continue

        commentary = ""
        if with_commentary and llm is not None:
            cache_key = f"{item.id}::{item.updated_at.isoformat()}"
            cached = cache.get(cache_key)
            if cached is not None:
                commentary = cached
                summary["commentary_cached"] += 1
            else:
                commentary = _draft_commentary(llm, item)
                cache[cache_key] = commentary
                summary["commentary_new"] += 1

        out.append(_normalize(item, commentary))

    # Sort: status priority groupings first, then by updatedAt desc.
    status_order = ["In Progress", "Blocked", "Todo", "Backlog", "Untriaged"]
    rank = {s.lower(): i for i, s in enumerate(status_order)}
    out.sort(key=lambda x: (rank.get((x["status"] or "").lower(), 99), x["updatedAt"]), reverse=False)

    save_site_part("roadmap", out)
    summary["kept"] = len(out)

    if with_commentary:
        # Prune cache entries that no longer match any current item.
        current_keys = {f"{i.id}::{i.updated_at.isoformat()}" for i in items}
        cache = {k: v for k, v in cache.items() if k in current_keys}
        _save_cache(cache)

    return summary
