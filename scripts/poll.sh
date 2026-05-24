#!/usr/bin/env bash
# Wrapper for cron / systemd timer / Windows Task Scheduler. Runs
# `bot poll-once` and logs to logs/poll.YYYY-MM.log. Exits non-zero on
# poller failure so the scheduler can surface bad runs.

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO"

mkdir -p logs
LOG="logs/poll.$(date +%Y-%m).log"

exec >> "$LOG" 2>&1
echo
echo "=== $(date -Iseconds) ==="
"$REPO/.venv/bin/bot" poll-once
