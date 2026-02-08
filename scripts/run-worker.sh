#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/mnt/data/claude-mem"
DATA_DIR="${CLAUDE_MEM_DATA_DIR:-$ROOT_DIR/.claude-mem}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$ROOT_DIR/claude-config}"

export HOME="$ROOT_DIR"
export CLAUDE_CONFIG_DIR="$CONFIG_DIR"
export CLAUDE_MEM_DATA_DIR="$DATA_DIR"

mkdir -p "$DATA_DIR" "$CONFIG_DIR"

exec /mnt/data/claude-mem/.bun/bin/bun /mnt/data/claude-mem/plugin/scripts/worker-service.cjs start
