"""File-based PID lock so manual, cron, and webhook-driven autoruns interlock.

Acquire via the `autorun_lock()` context manager. Stale locks (dead PID or
older than 30 minutes) are taken over with a warning.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .config import STATE_DB

logger = logging.getLogger(__name__)

LOCK_PATH = STATE_DB.parent / "autorun.lock"
STALE_AFTER_SECONDS = 30 * 60


class LockBusy(RuntimeError):
    """Another autorun is in progress and the existing lock is fresh."""


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_lock(path: Path) -> tuple[int, datetime] | None:
    try:
        data = json.loads(path.read_text())
        return int(data["pid"]), datetime.fromisoformat(data["started"])
    except (FileNotFoundError, json.JSONDecodeError, KeyError, ValueError):
        return None


def _payload() -> bytes:
    return json.dumps(
        {
            "pid": os.getpid(),
            "started": datetime.now(timezone.utc).isoformat(),
        }
    ).encode()


def _create_exclusive(path: Path) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        os.write(fd, _payload())
    finally:
        os.close(fd)


def _force_write(path: Path) -> None:
    path.write_bytes(_payload())


def peek_lock() -> tuple[int, datetime] | None:
    """Return (pid, started_at) of current holder, or None if not held."""
    return _read_lock(LOCK_PATH)


@contextmanager
def autorun_lock() -> Iterator[None]:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        _create_exclusive(LOCK_PATH)
    except FileExistsError:
        existing = _read_lock(LOCK_PATH)
        if existing is None:
            _force_write(LOCK_PATH)
            logger.warning("autorun.lock unreadable; took over")
        else:
            pid, started = existing
            age = (datetime.now(timezone.utc) - started).total_seconds()
            if not _pid_alive(pid):
                _force_write(LOCK_PATH)
                logger.warning("autorun.lock held by dead pid %d; took over", pid)
            elif age > STALE_AFTER_SECONDS:
                _force_write(LOCK_PATH)
                logger.warning(
                    "autorun.lock held by pid %d for %.0fs; stale, taking over",
                    pid,
                    age,
                )
            else:
                raise LockBusy(
                    f"autorun in progress (pid={pid}, started={started.isoformat()})"
                )
    try:
        yield
    finally:
        try:
            LOCK_PATH.unlink()
        except FileNotFoundError:
            pass
