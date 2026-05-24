from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .config import REPO_ROOT, Config
from .drafts import save_site_part


def bootstrap_from_website(cfg: Config) -> dict:
    """Import the website's current siteData.js into canonical JSON.

    Shells out to `node` since siteData.js is ES module JS, not JSON.
    Idempotent — safe to re-run; will overwrite local JSON with website state.
    """
    script = REPO_ROOT / "tools" / "dump-sitedata.mjs"
    target = cfg.website_sitedata_path
    if not target.exists():
        raise FileNotFoundError(f"website siteData.js not found at {target}")
    result = subprocess.run(
        ["node", str(script), str(target)],
        check=True,
        capture_output=True,
        text=True,
    )
    site = json.loads(result.stdout)
    save_site_part("profile", site.get("profile", {}))
    save_site_part("now", site.get("now", {"weekOf": "", "text": ""}))
    save_site_part("projects", site.get("projects", []))
    save_site_part("log", site.get("log", []))
    return site
