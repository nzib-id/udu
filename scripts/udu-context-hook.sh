#!/usr/bin/env bash
# UserPromptSubmit hook — auto-inject Udu SESSION_CONTEXT saat user prompt nyebut "udu"
# Safe: cuma output ke stdout (Claude inject as additional context); gagal = no-op
set -euo pipefail

INPUT="$(cat)"

PROMPT="$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get("prompt",""))
except Exception:
    pass' 2>/dev/null || true)"

if [ -z "$PROMPT" ]; then
  exit 0
fi

if printf '%s' "$PROMPT" | grep -Eiq '(^|[^a-z])udu([^a-z]|$)'; then
  CTX_FILE="/home/nzib/.openclaw/workspace/projects/udu/SESSION_CONTEXT.md"
  if [ -f "$CTX_FILE" ]; then
    echo "=== AUTO-INJECTED: Udu SESSION_CONTEXT.md ==="
    echo "Triggered by 'udu' mention in user prompt. Baca dulu sebelum action."
    echo ""
    cat "$CTX_FILE"
    echo ""
    echo "=== END AUTO-INJECTED CONTEXT ==="
  fi
fi

exit 0
