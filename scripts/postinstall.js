#!/usr/bin/env node

/**
 * Post-install script for claude-sidecar
 *
 * 1. Copies SKILL.md to ~/.claude/skills/sidecar/
 * 2. Registers MCP server in Claude Code (~/.claude.json)
 * 3. Registers MCP server in Claude Desktop/Cowork config
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..', 'skill');
const SKILL_SOURCE = path.join(SKILL_DIR, 'SKILL.md');
const SKILL_DEST_DIR = path.join(os.homedir(), '.claude', 'skills', 'sidecar');
const SKILL_DEST = path.join(SKILL_DEST_DIR, 'SKILL.md');

let AUTO_SKILLS = [];
try {
  AUTO_SKILLS = fs
    .readdirSync(SKILL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('auto-'))
    .map((entry) => entry.name)
    .sort();
} catch {
  // skill/ directory missing — continue with empty list
}

const MCP_CONFIG = { command: 'npx', args: ['-y', 'claude-sidecar@latest', 'mcp'] };

/**
 * Add or update an MCP server in a JSON config file.
 * Always overwrites the entry to ensure upgrades apply the latest config.
 *
 * @param {string} configPath - Path to the JSON config file
 * @param {string} name - MCP server name
 * @param {object} config - MCP server config object
 * @returns {string} 'added', 'updated', or 'unchanged'
 */
function addMcpToConfigFile(configPath, name, config) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  if (!existing.mcpServers) { existing.mcpServers = {}; }

  const prev = existing.mcpServers[name];
  const status = !prev ? 'added' : JSON.stringify(prev) !== JSON.stringify(config) ? 'updated' : 'unchanged';

  existing.mcpServers[name] = config;
  if (status !== 'unchanged') {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }
  return status;
}

/** Install skill files to ~/.claude/skills/ */
function installSkill() {
  try {
    fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
    fs.copyFileSync(SKILL_SOURCE, SKILL_DEST);
    console.log('[claude-sidecar] Skill installed to ~/.claude/skills/sidecar/');
  } catch (err) {
    console.error(`[claude-sidecar] Warning: Could not install skill: ${err.message}`);
  }

  const skillsRoot = path.join(os.homedir(), '.claude', 'skills');
  for (const name of AUTO_SKILLS) {
    try {
      const src = path.join(SKILL_DIR, name, 'SKILL.md');
      // Install as top-level skill (e.g., ~/.claude/skills/sidecar-auto-review/)
      // so Claude Code discovers it in the available skills list
      const destDir = path.join(skillsRoot, `sidecar-${name}`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
      console.log(`[claude-sidecar] Skill installed: sidecar-${name}`);

      // Clean up old nested location (~/.claude/skills/sidecar/<name>/)
      const oldDir = path.join(SKILL_DEST_DIR, name);
      try {
        if (fs.existsSync(path.join(oldDir, 'SKILL.md'))) {
          fs.unlinkSync(path.join(oldDir, 'SKILL.md'));
          fs.rmdirSync(oldDir);
        }
      } catch {
        // Old location doesn't exist or already cleaned — ignore
      }
    } catch (err) {
      console.error(`[claude-sidecar] Warning: Could not install ${name} skill: ${err.message}`);
    }
  }
}

/** Register MCP server in Claude Code config */
function registerClaudeCode() {
  // Try the CLI first
  try {
    const mcpJson = JSON.stringify(MCP_CONFIG);
    execFileSync('claude', ['mcp', 'add-json', 'sidecar', mcpJson, '--scope', 'user'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    console.log('[claude-sidecar] MCP registered in Claude Code (via CLI).');
    return;
  } catch {
    // CLI not available or failed — fall back to file edit
  }

  // Fallback: direct file edit
  const claudeConfigPath = path.join(os.homedir(), '.claude.json');
  const status = addMcpToConfigFile(claudeConfigPath, 'sidecar', MCP_CONFIG);
  if (status === 'added') {
    console.log('[claude-sidecar] MCP registered in Claude Code (~/.claude.json).');
  } else if (status === 'updated') {
    console.log('[claude-sidecar] MCP config updated in Claude Code (~/.claude.json).');
  } else {
    console.log('[claude-sidecar] MCP already registered in Claude Code.');
  }
}

/** Register MCP server in Claude Desktop / Cowork config */
function registerClaudeDesktop() {
  let configDir;
  if (process.platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  } else if (process.platform === 'win32') {
    configDir = path.join(process.env.APPDATA || '', 'Claude');
  } else {
    configDir = path.join(os.homedir(), '.config', 'claude');
  }

  const configPath = path.join(configDir, 'claude_desktop_config.json');
  const status = addMcpToConfigFile(configPath, 'sidecar', MCP_CONFIG);
  if (status === 'added') {
    console.log('[claude-sidecar] MCP registered in Claude Desktop.');
  } else if (status === 'updated') {
    console.log('[claude-sidecar] MCP config updated in Claude Desktop.');
  } else {
    console.log('[claude-sidecar] MCP already registered in Claude Desktop.');
  }
}

/**
 * Register activity monitoring hooks in ~/.claude/settings.json.
 * Resolves absolute paths to hook scripts at install time.
 * Merges sidecar hooks without overwriting existing user hooks.
 */
function registerHooks() {
  const hooksDir = path.join(__dirname, '..', 'hooks');
  const hooksConfigPath = path.join(hooksDir, 'hooks.json');
  if (!fs.existsSync(hooksConfigPath)) { return; }

  let hooksConfig;
  try {
    const raw = fs.readFileSync(hooksConfigPath, 'utf-8');
    // Escape backslashes for Windows paths before injecting into JSON
    const safeHooksDir = hooksDir.replace(/\\/g, '\\\\');
    hooksConfig = JSON.parse(raw.replace(/__HOOKS_DIR__/g, safeHooksDir));
  } catch (err) {
    console.error(`[claude-sidecar] Warning: Could not read hooks config: ${err.message}`);
    return;
  }

  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  if (!settings.hooks) { settings.hooks = {}; }

  // Merge each hook event, appending sidecar hooks after existing ones
  let registered = 0;
  for (const [event, matchers] of Object.entries(hooksConfig.hooks || {})) {
    if (!settings.hooks[event]) { settings.hooks[event] = []; }

    for (const matcher of matchers) {
      const cmd = (matcher.hooks && matcher.hooks[0] && matcher.hooks[0].command) || '';
      // Skip if this exact hook command is already registered
      const alreadyExists = settings.hooks[event].some((existing) => {
        return existing.hooks && existing.hooks.some((h) => h.command === cmd);
      });
      if (!alreadyExists) {
        settings.hooks[event].push(matcher);
        registered++;
      }
    }
  }

  if (registered > 0) {
    const settingsDir = path.dirname(settingsPath);
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  // First-run notice
  console.log('');
  console.log('[claude-sidecar] Activity monitoring hooks registered:');
  console.log('  - PreToolUse: auto-security gate (git commit/push/PR)');
  console.log('  - PostToolUse: BMAD artifact trigger + event collection');
  console.log('  - PostToolUseFailure: failure event collection');
  console.log('');
  console.log('  Auto-skills suggest security scans, code reviews, and unblock');
  console.log('  assistance at key workflow moments.');
  console.log('');
  console.log('  To disable: sidecar auto-skills --off');
  console.log('  Config: ~/.config/sidecar/config.json');
}

function main() {
  console.log('[claude-sidecar] Installing...');
  installSkill();
  registerClaudeCode();
  registerClaudeDesktop();
  registerHooks();

  // Warn if jq is not available (hooks degrade gracefully but lose functionality)
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe', timeout: 5000 });
  } catch {
    console.log('');
    console.log('[claude-sidecar] Warning: `jq` is not installed.');
    console.log('  Activity monitoring hooks require jq for JSON parsing.');
    console.log('  Install it: brew install jq (macOS) or apt install jq (Linux)');
    console.log('  Without jq, hooks will degrade gracefully (auto-skills still work via description-matching).');
  }

  console.log('');
  console.log('[claude-sidecar] Setup:');
  console.log('  - Configure API: Run `sidecar setup` or set API keys directly');
  console.log('  - API keys: OPENROUTER_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, etc.');
}

// Only run main when executed directly (not when required for testing)
if (require.main === module) {
  main();
}

module.exports = { addMcpToConfigFile, registerHooks };
