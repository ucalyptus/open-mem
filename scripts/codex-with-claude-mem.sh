#!/usr/bin/env bash
set -euo pipefail

/mnt/data/claude-mem/scripts/start-worker-if-needed.sh
/mnt/data/claude-mem/scripts/start-codex-ingest-if-needed.sh

if ! /mnt/data/claude-mem/scripts/worker-health.sh >/dev/null 2>&1; then
  echo "claude-mem: worker health check failed (starting anyway)" >&2
fi

wrapper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
path_no_wrapper=""
IFS=':' read -ra path_parts <<< "${PATH:-}"
for p in "${path_parts[@]}"; do
  # Normalize p by cd-ing into it if it exists
  p_abs=""
  if [ -d "$p" ]; then
    p_abs="$(cd "$p" && pwd)"
  else
    p_abs="$p"
  fi

  if [ "$p_abs" != "$wrapper_dir" ]; then
    path_no_wrapper+="${path_no_wrapper:+:}$p"
  fi
done

real_codex="$(PATH="$path_no_wrapper" command -v codex || true)"
if [ -z "$real_codex" ]; then
  echo "codex not found on PATH." >&2
  exit 127
fi

exec "$real_codex" "$@"