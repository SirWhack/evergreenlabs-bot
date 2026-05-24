"""One-shot poller: fetch queued events from the Worker, run autorun if any,
drain the queue on success. On failure (Worker unreachable, autorun raises)
events stay queued so the next poll retries them.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .autorun import run as do_autorun
from .config import Config

logger = logging.getLogger(__name__)

POLL_TIMEOUT = 10.0


class PollerError(RuntimeError):
    pass


def _require_config(cfg: Config) -> tuple[str, str]:
    if not cfg.worker_url or not cfg.bot_poll_token:
        raise PollerError("WORKER_URL and BOT_POLL_TOKEN must be set in .env")
    return cfg.worker_url.rstrip("/"), cfg.bot_poll_token


def _fetch_events(cfg: Config) -> list[dict[str, Any]]:
    url, token = _require_config(cfg)
    r = httpx.get(
        f"{url}/events",
        headers={"Authorization": f"Bearer {token}"},
        timeout=POLL_TIMEOUT,
    )
    r.raise_for_status()
    return r.json().get("events", [])


def _drain(cfg: Config, delivery_ids: list[str]) -> int:
    url, token = _require_config(cfg)
    r = httpx.request(
        "DELETE",
        f"{url}/events",
        headers={"Authorization": f"Bearer {token}"},
        json={"delivery_ids": delivery_ids},
        timeout=POLL_TIMEOUT,
    )
    r.raise_for_status()
    return int(r.json().get("deleted", 0))


def poll_once(cfg: Config) -> dict[str, Any]:
    try:
        events = _fetch_events(cfg)
    except httpx.HTTPError as e:
        logger.warning("worker unreachable: %s", e)
        return {"events": 0, "ran": False, "drained": 0, "error": str(e)}

    if not events:
        return {"events": 0, "ran": False, "drained": 0}

    ids = [e["delivery_id"] for e in events if e.get("delivery_id")]
    logger.info("fetched %d events, running autorun", len(events))

    summary = do_autorun(cfg)

    drained = _drain(cfg, ids)
    return {
        "events": len(events),
        "ran": True,
        "drained": drained,
        "autorun": summary,
    }
