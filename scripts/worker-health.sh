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
URL="${CLAUDE_MEM_API:-http://127.0.0.1:${PORT}}/api/health"

if command -v curl >/dev/null 2>&1; then
  curl -sf "$URL"
  exit 0
fi

echo "curl not found" >&2
exit 1
