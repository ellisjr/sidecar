#!/usr/bin/env bash
# PostToolUse hook: event collection + BMAD artifact trigger.
#
# Reads JSON from stdin (Claude Code hook contract).
# 1. Appends a structured event to session JSONL file (for Phase 2 analysis).
# 2. If a Write/Edit/MultiEdit targets _bmad-output/, injects additionalContext.
#
# Phase 1: shell-only, no Node.js dependency.

set -euo pipefail

# Safety guard
[ -f "$0" ] || exit 0

# ── Config check ──────────────────────────────────────────────────────
# Note: jq's // operator treats false as falsy, so we use explicit type checks
CONFIG_PATH="${HOME}/.config/sidecar/config.json"
MONITORING_ON="true"
BMAD_ON="true"
MASTER_ON="true"

if [ -f "$CONFIG_PATH" ] && command -v jq >/dev/null 2>&1; then
  MASTER_ON=$(jq -r '.autoSkills.enabled | if type == "boolean" then . else true end' "$CONFIG_PATH" 2>/dev/null || echo "true")
  BMAD_ON=$(jq -r '.autoSkills.bmadMethodCheck.enabled | if type == "boolean" then . else true end' "$CONFIG_PATH" 2>/dev/null || echo "true")
  MONITORING_ON=$(jq -r '.monitoring.enabled | if type == "boolean" then . else true end' "$CONFIG_PATH" 2>/dev/null || echo "true")
fi

# If master auto-skills switch or monitoring is off, skip everything
if [ "$MASTER_ON" = "false" ] || [ "$MONITORING_ON" = "false" ]; then
  exit 0
fi

# ── Read stdin to temp file (avoid ARG_MAX on large payloads) ─────────
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TMP_JSON=$(mktemp)
trap 'rm -f "$TMP_JSON"' EXIT
cat > "$TMP_JSON"

TOOL_NAME=$(jq -r '.tool_name // ""' "$TMP_JSON" 2>/dev/null || echo "")
SESSION_ID=$(jq -r '.session_id // ""' "$TMP_JSON" 2>/dev/null || echo "")

# ── Event collection ─────────────────────────────────────────────────
# Append structured event to session-specific JSONL file
if [ -n "$SESSION_ID" ]; then
  EVENT_FILE="${TMPDIR:-/tmp}/sidecar-monitor-${SESSION_ID}.jsonl"

  EVENT=$(jq -rc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {
      ts: $ts,
      tool: (.tool_name // "unknown"),
      file: (if .tool_name == "Bash" then ""
             elif .tool_name == "MultiEdit" then (.tool_input.edits[0].file_path // "")
             else (.tool_input.file_path // "") end),
      success: (if .tool_name == "Bash" then ((.tool_response.exit_code // 0) == 0) else true end),
      command: (if .tool_name == "Bash" then (.tool_input.command // "") else "" end)
    }' "$TMP_JSON" 2>/dev/null || echo "")

  if [ -n "$EVENT" ]; then
    # Create with restrictive permissions if new; append otherwise
    if [ ! -f "$EVENT_FILE" ]; then
      touch "$EVENT_FILE" && chmod 600 "$EVENT_FILE"
    fi
    echo "$EVENT" >> "$EVENT_FILE"
  fi
fi

# ── BMAD artifact trigger ────────────────────────────────────────────
# Only fire if master + bmadMethodCheck are enabled
if [ "$MASTER_ON" = "false" ] || [ "$BMAD_ON" = "false" ]; then
  exit 0
fi

# Check if a Write, Edit, or MultiEdit targeted _bmad-output/
# MultiEdit uses .tool_input.edits[].file_path; Write/Edit use .tool_input.file_path
if [ "$TOOL_NAME" = "Write" ] || [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "MultiEdit" ]; then
  HAS_BMAD=$(jq -r '
    [.tool_input.file_path, (.tool_input.edits[]?.file_path)]
    | map(select(. != null and contains("_bmad-output/")))
    | length > 0' "$TMP_JSON" 2>/dev/null || echo "false")

  if [ "$HAS_BMAD" = "true" ]; then
    # Extract a representative file path for the message
    BMAD_FILE=$(jq -r '
      [.tool_input.file_path, (.tool_input.edits[]?.file_path)]
      | map(select(. != null and contains("_bmad-output/")))
      | first' "$TMP_JSON" 2>/dev/null || echo "_bmad-output/")

    cat <<HOOK_OUTPUT
{
  "hookSpecificOutput": {
    "additionalContext": "A BMAD-METHOD artifact was just written or updated at ${BMAD_FILE}. Consider running the sidecar-auto-bmad-method-check skill to get a second-opinion review from another model before finalizing this artifact. You can invoke it with: use the Skill tool with skill 'sidecar-auto-bmad-method-check'. If the user has already reviewed this artifact or explicitly declined a check, proceed without one."
  }
}
HOOK_OUTPUT
    exit 0
  fi
fi
