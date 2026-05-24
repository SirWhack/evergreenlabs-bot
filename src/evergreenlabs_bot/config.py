from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
SITE_DIR = DATA_DIR / "site"
DRAFTS_DIR = DATA_DIR / "drafts"
STATE_DB = DATA_DIR / "state.db"


@dataclass(frozen=True)
class Config:
    github_username: str
    github_token: str | None
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    website_repo_path: Path
    website_sitedata_rel: str
    publish_git_commit: bool
    publish_git_push: bool

    @property
    def website_sitedata_path(self) -> Path:
        return self.website_repo_path / self.website_sitedata_rel


def _bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_config() -> Config:
    load_dotenv(REPO_ROOT / ".env")
    username = os.environ.get("GITHUB_USERNAME", "").strip()
    if not username:
        raise RuntimeError("GITHUB_USERNAME not set in .env")
    model = os.environ.get("LLM_MODEL", "").strip()
    if not model:
        raise RuntimeError("LLM_MODEL not set in .env")
    return Config(
        github_username=username,
        github_token=os.environ.get("GITHUB_TOKEN", "").strip() or None,
        llm_base_url=os.environ.get("LLM_BASE_URL", "http://localhost:8000/v1").strip(),
        llm_api_key=os.environ.get("LLM_API_KEY", "not-needed").strip() or "not-needed",
        llm_model=model,
        website_repo_path=Path(
            os.environ.get("WEBSITE_REPO_PATH", "/home/swynn/Code/evergreenlabs")
        ).expanduser().resolve(),
        website_sitedata_rel=os.environ.get(
            "WEBSITE_SITEDATA_REL", "src/content/siteData.js"
        ),
        publish_git_commit=_bool(os.environ.get("PUBLISH_GIT_COMMIT"), True),
        publish_git_push=_bool(os.environ.get("PUBLISH_GIT_PUSH"), False),
    )
