#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${CLAUDE_MEM_LOG_DIR:-/mnt/data/claude-mem/.claude-mem/logs}"
LOG_FILE="$LOG_DIR/codex-ingest.log"

mkdir -p "$LOG_DIR"

if pgrep -f "ingest-codex-jsonl" >/dev/null 2>&1; then
  exit 0
fi

nohup /mnt/data/claude-mem/scripts/run-codex-ingest.sh \
  >"$LOG_FILE" 2>&1 &
