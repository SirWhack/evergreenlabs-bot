from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from .config import DRAFTS_DIR, SITE_DIR

DraftKind = Literal["log_entry", "now_text"]


# ---------- canonical site store ----------


def _site_file(name: str) -> Path:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    return SITE_DIR / f"{name}.json"


def load_site_part(name: str, default: Any) -> Any:
    p = _site_file(name)
    if not p.exists():
        return default
    return json.loads(p.read_text())


def save_site_part(name: str, value: Any) -> None:
    p = _site_file(name)
    p.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def load_site() -> dict:
    return {
        "profile": load_site_part("profile", {}),
        "now": load_site_part("now", {"weekOf": "", "text": ""}),
        "projects": load_site_part("projects", []),
        "log": load_site_part("log", []),
    }


# ---------- drafts ----------


@dataclass
class Draft:
    id: str
    kind: DraftKind
    payload: dict
    source_commits: list[str] = field(default_factory=list)
    source_repo: str | None = None
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    status: Literal["pending", "accepted", "rejected"] = "pending"
    notes: str = ""

    def path(self) -> Path:
        DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
        return DRAFTS_DIR / f"{self.id}.json"

    def save(self) -> None:
        self.path().write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False))

    def delete(self) -> None:
        p = self.path()
        if p.exists():
            p.unlink()


def new_draft(
    kind: DraftKind,
    payload: dict,
    source_commits: list[str] | None = None,
    source_repo: str | None = None,
) -> Draft:
    return Draft(
        id=uuid.uuid4().hex[:12],
        kind=kind,
        payload=payload,
        source_commits=list(source_commits or []),
        source_repo=source_repo,
    )


def list_drafts(status: str | None = "pending") -> list[Draft]:
    if not DRAFTS_DIR.exists():
        return []
    out: list[Draft] = []
    for p in sorted(DRAFTS_DIR.glob("*.json")):
        raw = json.loads(p.read_text())
        d = Draft(**raw)
        if status is None or d.status == status:
            out.append(d)
    out.sort(key=lambda d: d.created_at)
    return out


def load_draft(draft_id: str) -> Draft:
    p = DRAFTS_DIR / f"{draft_id}.json"
    return Draft(**json.loads(p.read_text()))
