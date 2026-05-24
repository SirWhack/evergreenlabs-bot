#!/usr/bin/env bash
# Wrapper for Windows Task Scheduler / systemd. Runs `bot autorun` and logs
# output to logs/autorun.YYYY-MM.log. Exits non-zero on bot failure so the
# scheduler can surface failed runs.

set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO"

mkdir -p logs
LOG="logs/autorun.$(date +%Y-%m).log"

exec >> "$LOG" 2>&1
echo
echo "=== $(date -Iseconds) ==="
"$REPO/.venv/bin/bot" autorun
echo
