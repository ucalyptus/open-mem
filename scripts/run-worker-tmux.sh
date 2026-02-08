#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/mnt/data/claude-mem"
DATA_DIR="${CLAUDE_MEM_DATA_DIR:-$ROOT_DIR/.claude-mem}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$ROOT_DIR/claude-config}"
LOG_DIR="${CLAUDE_MEM_LOG_DIR:-$DATA_DIR/logs}"
LOG_FILE="$LOG_DIR/claude-mem-tmux.log"

mkdir -p "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR"

CMD="export HOME='$ROOT_DIR'; export CLAUDE_CONFIG_DIR='$CONFIG_DIR'; export CLAUDE_MEM_DATA_DIR='$DATA_DIR'; /mnt/data/claude-mem/.bun/bin/bun /mnt/data/claude-mem/plugin/scripts/worker-service.cjs >>'$LOG_FILE' 2>&1"

nohup bash -lc "$CMD" >/dev/null 2>&1 &
