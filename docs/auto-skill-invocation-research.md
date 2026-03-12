# Auto-Skill Invocation: Research & Recommendations

Research into how Claude Code skills achieve reliable invocation, with specific recommendations for improving sidecar auto-skill trigger reliability.

## Background

Sidecar ships four auto-skills — `auto-review`, `auto-unblock`, `auto-security`, and `auto-bmad-method-check` — that fire contextually at key workflow moments. Unlike user-invocable skills (which have slash commands like `/commit`), auto-skills were originally designed to rely solely on Claude recognizing trigger conditions in the conversation and reading the skill file proactively.

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

### Critical Discovery: Nesting Depth Matters

Claude Code only discovers skills at the **top level** of `~/.claude/skills/`. A skill at `~/.claude/skills/my-skill/SKILL.md` appears in the available skills list; a skill nested at `~/.claude/skills/parent/child/SKILL.md` does **not**. This was the root cause of the original visibility gap — auto-skills were installed as nested subdirectories under the main sidecar skill.

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

## What We've Done

### Step 1: Add Auto-Skills to Main SKILL.md (Option B) ✅ Done

Added an "Auto-Skills: Contextual Sidecar Triggers" section to the main `skill/SKILL.md` listing all four auto-skills with their trigger conditions in a table. Since the main sidecar skill appears in the available skills list, Claude gets passive awareness of auto-skill triggers when it reads the main skill.

**Pros:** Simple one-file change, no new infrastructure needed.
**Cons:** Only provides awareness when sidecar context is active — Claude has to read the main skill first.

### Step 2: Top-Level Installation for Skills List Visibility (Option D) ✅ Done

Moved auto-skills from nested directories (`~/.claude/skills/sidecar/auto-*/`) to top-level directories (`~/.claude/skills/sidecar-auto-*/`). This makes them appear in Claude Code's "available skills" system reminder every turn.

**Changes made:**
- `postinstall.js` — installs auto-skills to `~/.claude/skills/sidecar-auto-review/` etc. (top-level), cleans up old nested path
- All 4 SKILL.md frontmatters — `name` field updated to `sidecar-auto-review`, `sidecar-auto-unblock`, `sidecar-auto-security`, `sidecar-auto-bmad-method-check`
- Main SKILL.md — updated reference path, mentions slash-command invocation

**Result:** All four auto-skills now appear in the available skills list with their full trigger descriptions. They support both:
- **Auto-fire** — Claude pattern-matches trigger conditions from the skills list every turn
- **Manual invocation** — user can type `/sidecar-auto-review`, `/sidecar-auto-security`, etc.

**Verified:** After local installation, the system reminder now includes entries like:
```text
- sidecar-auto-review: Use after completing a feature implementation, bug fix, or significant code change...
- sidecar-auto-unblock: Use when you have attempted 5 or more different approaches to fix a bug...
- sidecar-auto-security: Use when the user asks to commit changes, push code, or create a pull request...
- sidecar-auto-bmad-method-check: Use when a BMAD-METHOD workflow has just produced an output artifact...
```

### Current State

| Mechanism | Superpowers | Sidecar Auto-Skills |
|-----------|-------------|---------------------|
| SessionStart hook | Yes — injects meta-instruction | Not yet |
| System prompt injection | Yes — `<EXTREMELY_IMPORTANT>` tags | Not yet |
| Available skills list | Yes — all skills listed with descriptions | **Yes** — all 4 auto-skills listed ✅ |
| Meta-instruction forcing skill checks | Yes — "ABSOLUTELY MUST" language | No — benefits from Superpowers if installed |
| Trigger specification | Description field | Description field (same format) ✅ |
| Manual invocation fallback | Yes — slash commands | **Yes** — `/sidecar-auto-*` commands ✅ |

The critical gap (skills list visibility) is now closed. The remaining gap is the SessionStart hook — without it, sidecar auto-skills rely on either (a) Superpowers being installed to force skill checking, or (b) Claude independently deciding to check skills based on the available skills list.

## Remaining Recommendations

### Next: SessionStart Hook (Option A)

Register a lightweight SessionStart hook in sidecar's postinstall that injects a brief auto-skills reminder into the system prompt. This would mirror what Superpowers does but scoped to sidecar triggers.

**Implementation:**
1. Create `hooks/hooks.json` with SessionStart matcher
2. Create a hook script that injects a compact reminder:
   ```text
   Sidecar auto-skills are installed. When you recognize these trigger conditions,
   invoke the corresponding skill:
   - /sidecar-auto-review — after implementing changes, before telling user "done"
   - /sidecar-auto-unblock — after 5+ failed fix attempts
   - /sidecar-auto-security — before git commit/push/PR
   - /sidecar-auto-bmad-method-check — after writing BMAD artifacts in _bmad-output/
   ```
3. Register the hook during postinstall alongside MCP and skill file installation

**Pros:** Matches Superpowers' proven pattern. Always present from session start. Works independent of Superpowers. Combined with skills list visibility (already done), this would give two independent triggering paths.
**Cons:** Requires hook infrastructure (hooks.json, hook script, postinstall changes). Adds to system prompt size every session.

**Open question:** Does the Claude Code hooks API support `experimental.chat.system.transform` for third-party packages, or is this restricted to plugins? If restricted, the hook could use the simpler `command` type to emit the reminder, though this is less reliable than system prompt injection.

### Future: Auto-Skills Framework in Sidecar Config

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

### Future: Community Auto-Skills

The top-level installation pattern (`~/.claude/skills/sidecar-auto-*/`) and dynamic discovery in postinstall (`fs.readdirSync` for `auto-*` directories) means third-party auto-skills could be contributed by following the same convention:
1. Add a `skill/auto-<name>/SKILL.md` to the repo
2. Postinstall automatically discovers and installs it as `~/.claude/skills/sidecar-auto-<name>/`
3. No hardcoded lists to maintain

## Summary

| Approach | Effort | Reliability | Status |
|----------|--------|-------------|--------|
| **B: Main SKILL.md section** | Low | Medium — works when sidecar context is active | ✅ Done |
| **D: Top-level installation** | Low | High — Claude checks skills list every turn | ✅ Done |
| **A: SessionStart hook** | Medium | Very high — always present from session start | Recommended next |
| **Config framework** | High | Very high — user-configurable | Future |

**Current reliability:** With options B and D both implemented, auto-skills have strong visibility through the available skills list. The main remaining improvement is a SessionStart hook (Option A) for environments where Superpowers is not installed, ensuring skill awareness is always injected at session start regardless of other plugins.
