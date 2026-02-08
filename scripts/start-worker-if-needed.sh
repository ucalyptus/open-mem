#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${CLAUDE_MEM_DATA_DIR:-/mnt/data/claude-mem/.claude-mem}"
SETTINGS_FILE="$DATA_DIR/settings.json"

get_port() {
  if [ -f "$SETTINGS_FILE" ] && command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' "$SETTINGS_FILE"
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("CLAUDE_MEM_WORKER_PORT", "37777"))
PY
    return
  fi
  echo "37777"
}

PORT="$(get_port)"
API_URL="${CLAUDE_MEM_API:-http://127.0.0.1:${PORT}}/api/health"

if command -v curl >/dev/null 2>&1; then
  if curl -sf "$API_URL" >/dev/null 2>&1; then
    exit 0
  fi
fi

status_output="$("/mnt/data/claude-mem/scripts/status-worker.sh" 2>/dev/null || true)"

if echo "$status_output" | grep -Eiq "not running|stopped|dead"; then
  /mnt/data/claude-mem/scripts/run-worker.sh

  if command -v curl >/dev/null 2>&1; then
    sleep 0.5
    if curl -sf "$API_URL" >/dev/null 2>&1; then
      exit 0
    fi
  fi

  /mnt/data/claude-mem/scripts/run-worker-tmux.sh
  exit 0
fi

if [ -z "$status_output" ]; then
  /mnt/data/claude-mem/scripts/run-worker.sh

  if command -v curl >/dev/null 2>&1; then
    sleep 0.5
    if curl -sf "$API_URL" >/dev/null 2>&1; then
      exit 0
    fi
  fi

  /mnt/data/claude-mem/scripts/run-worker-tmux.sh
fi
