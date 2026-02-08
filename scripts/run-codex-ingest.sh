#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${CODEX_SESSIONS_ROOT:-/mnt/data/claude-mem/codex/sessions}"
API_BASE="${CLAUDE_MEM_API:-http://127.0.0.1:37777}"

mkdir -p "$ROOT_DIR"

exec node /mnt/data/claude-mem/scripts/ingest-codex-jsonl.mjs \
  --root "$ROOT_DIR" \
  --api "$API_BASE"
