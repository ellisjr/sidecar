# Auto-Skill Invocation: Research & Recommendations

Research into how Claude Code skills achieve reliable invocation, with specific recommendations for improving sidecar auto-skill trigger reliability.

## Background

Sidecar ships four auto-skills — `auto-review`, `auto-unblock`, `auto-security`, and `auto-bmad-method-check` — that fire contextually at key workflow moments. Unlike user-invocable skills (which have slash commands like `/commit`), auto-skills rely on Claude recognizing trigger conditions in the conversation and reading the skill file proactively.

The question: **how do we ensure Claude actually fires these skills when conditions are met?**

## How Claude Code Skills Work

### Skill Discovery

Skills live as `SKILL.md` files with YAML frontmatter in two locations:
- `~/.claude/skills/<name>/SKILL.md` — user/package skills
- `~/.claude/plugins/cache/<plugin>/skills/<name>/SKILL.md` — plugin skills

Claude discovers skills via the **Skill tool**, which scans these directories and exposes all SKILL.md files. The `description` field in frontmatter serves as the **declarative trigger specification** — Claude evaluates it against conversation state to decide whether to invoke.

### Invocation Pipeline

```text
1. Skill tool scans filesystem → builds list of available skills
2. Skill descriptions appear in system reminders ("available skills" block)
3. Claude evaluates descriptions against conversation state each turn
4. If match → Claude reads the full SKILL.md and follows its procedure
```

### Key Mechanism: The "Available Skills" System Reminder

Every turn, Claude sees a system reminder listing available skills with their descriptions. This is the primary discovery mechanism. **Skills that appear in this list are far more likely to be invoked** because Claude evaluates them on every turn.

## How Superpowers Achieves Near-100% Reliability

The Superpowers plugin (Claude's official skill framework) uses a three-layer reinforcement strategy:

### Layer 1: SessionStart Hook (Most Critical)

Superpowers registers a **synchronous SessionStart hook** that fires on every startup, resume, clear, and compact event. This hook:

1. Reads `using-superpowers/SKILL.md` from disk
2. Injects its content into the system prompt via `experimental.chat.system.transform`
3. Wraps it in `<EXTREMELY_IMPORTANT>` tags

This means the meta-instruction is present **before any user input**, on every session.

**Hook registration** (`hooks.json`):
```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|resume|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
        "async": false
      }]
    }]
  }
}
```

### Layer 2: Meta-Instruction

The injected content contains a forceful meta-instruction:

> "If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill. This is not negotiable. This is not optional. You cannot rationalize your way out of this."

It also includes a "Red Flags" table of rationalizations Claude should watch for (e.g., "This is just a simple question" → "Questions are tasks. Check for skills.").

### Layer 3: Available Skills List

All Superpowers skills appear in the "available skills" system reminder with descriptions like:
- `systematic-debugging: Use when encountering any bug, test failure, or unexpected behavior`
- `brainstorming: You MUST use this before any creative work`

Claude sees these every turn, making pattern matching automatic.

### Why This Works

The three layers create **redundant triggering paths**:
- Even if Claude skips the skill check, the meta-instruction reminds it
- Even if the meta-instruction is missed, the skills list surfaces matches
- Even if the skills list is scrolled past, the SessionStart hook re-injects on context reset

## Where Sidecar Auto-Skills Stand Today

### What We Have

1. **SKILL.md files** with `TRIGGER when:` clauses in descriptions — installed to `~/.claude/skills/sidecar/auto-*/`
2. **Main sidecar skill** (`~/.claude/skills/sidecar/SKILL.md`) — appears in the available skills list
3. **MCP tools** — `sidecar_start`, `sidecar_status`, `sidecar_read` available when MCP server is running

### The Gap

| Mechanism | Superpowers | Sidecar Auto-Skills |
|-----------|-------------|---------------------|
| SessionStart hook | Yes — injects meta-instruction | No |
| System prompt injection | Yes — `<EXTREMELY_IMPORTANT>` tags | No |
| Available skills list | Yes — all skills listed with descriptions | No — auto-skills not listed* |
| Meta-instruction forcing skill checks | Yes — "ABSOLUTELY MUST" language | No — relies on Superpowers being installed |
| Trigger specification | Description field | Description field (same format) |

*Auto-skills are discoverable via the Skill tool filesystem scan but do **not** appear in the "available skills" system reminder that Claude sees every turn. This is the critical gap.

### Practical Impact

- If Superpowers is installed: auto-skills **may** fire because Superpowers forces Claude to check for skills. But Claude still has to discover them via filesystem scan rather than seeing them in the skills list.
- If Superpowers is NOT installed: auto-skills have **no mechanism** prompting Claude to check for them. They exist on disk but Claude has no reason to look.
- Auto-skills are **invisible** in the available skills reminder, so even an instruction-following Claude won't pattern-match against them unless something else prompts a skill check.

## Recommendations

### Immediate: Add Auto-Skills to Main SKILL.md (Option B) ✅ Done

Add a section to the main `skill/SKILL.md` that lists all auto-skills with their trigger conditions. Since the main sidecar skill already appears in the available skills list, Claude will see the auto-skill triggers when reading the main skill.

**Pros:** Simple one-file change, no new infrastructure needed, works today.
**Cons:** Relies on Claude reading the full main skill (which it does when sidecar is relevant, but not every turn). Only provides awareness when sidecar context is active.

### Short-Term: SessionStart Hook (Option A)

Register a lightweight SessionStart hook in sidecar's postinstall that injects a brief auto-skills reminder into the system prompt. This would mirror what Superpowers does but scoped to sidecar triggers.

**Implementation:**
1. Create `hooks/hooks.json` with SessionStart matcher
2. Create a hook script that injects a compact reminder:
   ```text
   Sidecar auto-skills are available. Check trigger conditions:
   - auto-review: after implementing changes, before telling user "done"
   - auto-unblock: after 5+ failed fix attempts
   - auto-security: before git commit/push/PR
   - auto-bmad-method-check: after writing BMAD artifacts in _bmad-output/
   Read the full skill from ~/.claude/skills/sidecar/<name>/SKILL.md when triggered.
   ```
3. Register the hook during postinstall alongside MCP and skill file installation

**Pros:** Matches Superpowers' proven pattern. Always present from session start. Works independent of Superpowers.
**Cons:** Requires hook infrastructure (hooks.json, hook script, postinstall changes). Adds to system prompt size every session.

**Open question:** Does the Claude Code hooks API support `experimental.chat.system.transform` for third-party packages, or is this restricted to plugins? If restricted, the hook could use the simpler `command` type to emit the reminder, though this is less reliable than system prompt injection.

### Medium-Term: Make Auto-Skills Appear in Skills List (Option D)

Give auto-skills optional slash-command names (e.g., `/auto-review`, `/auto-security`) so they appear in the available skills system reminder. Keep the auto-fire behavior — the slash command would just be an alternative manual trigger.

**Pros:** Skills appear in the list Claude checks every turn. Belt and suspenders with auto-fire.
**Cons:** May confuse users who see skills they didn't know about. Pollutes the skills namespace. May not be possible without changes to how Claude Code lists skills.

### Long-Term: Auto-Skills Framework in Sidecar Config

If sidecar adds an `autoSkills` config namespace, centralize trigger definitions and enable/disable switches:

```json
{
  "autoSkills": {
    "review": { "enabled": true, "model": "gemini" },
    "unblock": { "enabled": true, "attemptThreshold": 5 },
    "security": { "enabled": true, "scanOnCommit": true },
    "bmadMethodCheck": { "enabled": true, "artifactDir": "_bmad-output/" }
  }
}
```

This would let users customize which auto-skills fire and with what defaults, without editing SKILL.md files.

## Summary

| Approach | Effort | Reliability | Independence from Superpowers |
|----------|--------|-------------|-------------------------------|
| **B: Main SKILL.md section** (done) | Low | Medium — works when sidecar context is active | Partial — still benefits from Superpowers |
| **A: SessionStart hook** | Medium | High — always present from session start | Full — self-contained |
| **D: Skills list appearance** | Low-Medium | High — Claude checks every turn | Full |
| **Config framework** | High | High — user-configurable | Full |

**Recommended path:** B (done) → A (next PR) → Config framework (when sidecar adds autoSkills namespace).
