#!/usr/bin/env bash
# PostToolUseFailure hook: failure event collection.
#
# Reads JSON from stdin (Claude Code hook contract).
# Appends a failure event to session JSONL for Phase 2 analysis.
# No triggers in Phase 1 — purely collecting data for the Stop hook analyzer.

set -euo pipefail

# Safety guard
[ -f "$0" ] || exit 0

# ── Config check ──────────────────────────────────────────────────────
# Note: jq's // operator treats false as falsy, so we use explicit type checks
CONFIG_PATH="${HOME}/.config/sidecar/config.json"
if [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  MASTER=$(jq -r '.autoSkills.enabled | if type == "boolean" then . else true end' "$CONFIG_PATH" 2>/dev/null || echo "true")
  MONITORING=$(jq -r '.monitoring.enabled | if type == "boolean" then . else true end' "$CONFIG_PATH" 2>/dev/null || echo "true")
  if [ "$MASTER" = "false" ] || [ "$MONITORING" = "false" ]; then
    exit 0
  fi
fi

# ── Read stdin to temp file (avoid ARG_MAX on large payloads) ─────────
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TMP_JSON=$(mktemp 2>/dev/null) || exit 0
trap 'rm -f "$TMP_JSON"' EXIT
cat > "$TMP_JSON"

SESSION_ID=$(jq -r '.session_id // ""' "$TMP_JSON" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# ── Append failure event ─────────────────────────────────────────────
EVENT_FILE="${TMPDIR:-/tmp}/sidecar-monitor-${SESSION_ID}.jsonl"

EVENT=$(jq -rc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  {
    ts: $ts,
    tool: (.tool_name // "unknown"),
    file: (if .tool_name == "MultiEdit" then (.tool_input.edits[0].file_path // "")
           else (.tool_input.file_path // "") end),
    success: false,
    command: (if .tool_name == "Bash" then (.tool_input.command // "") else "" end),
    errorSnippet: ((.error // .tool_response.error // .tool_response.stderr // "")[:500])
  }' "$TMP_JSON" 2>/dev/null || echo "")

if [ -n "$EVENT" ]; then
  if [ ! -f "$EVENT_FILE" ]; then
    touch "$EVENT_FILE" && chmod 600 "$EVENT_FILE"
  fi
  echo "$EVENT" >> "$EVENT_FILE"
fi
