#!/usr/bin/env bash
# Wire this bundle into the locally installed agent CLIs (idempotent).
#
# Covers: Grok Build (grok), Amp (amp), Hermes (hermes), OpenClaw (openclaw),
# VS Code (chat.pluginLocations), Devin (skill links).
#
# Other hosts use their own mechanisms:
#   - Claude Code / Cursor / Codex: see docs/COMPATIBILITY.md
#   - Rovo Dev CLI: scripts/install-rovodev.sh
#
# Re-run any time; existing entries are left as-is. Files edited directly
# (VS Code settings.json) are backed up before writing.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The MCP servers are registered against the published npm package; the
# npx-spawned process inherits SOURCERY_API_KEY from the launching environment.
NPM_SPEC="@abyssbugg/sourcery@latest"

echo "plugin root: $PLUGIN_ROOT"

# Link each skill into a host skills directory. `ln -sfn DEST` creates the link
# *inside* an existing real directory, so real directories are left alone.
link_skills() {
  local dest_dir="$1"
  mkdir -p "$dest_dir"
  for skill in "$PLUGIN_ROOT"/skills/*/; do
    local source="${skill%/}"
    local dest="$dest_dir/$(basename "$source")"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      echo "skills: $dest is a real directory, leaving as-is"
      continue
    fi
    ln -sfn "$source" "$dest"
  done
}

# --- grok ------------------------------------------------------------------
if command -v grok >/dev/null 2>&1; then
  if grok mcp list 2>/dev/null | grep -q "sourcery"; then
    echo "grok: sourcery MCP server already configured"
  else
    grok mcp add sourcery --scope user -- npx -y "$NPM_SPEC" >/dev/null && echo "grok: added sourcery MCP server (user scope)"
  fi
  link_skills "$HOME/.grok/skills"
  echo "grok: skills linked into ~/.grok/skills/"
else
  echo "grok: not installed, skipping"
fi

# --- amp -------------------------------------------------------------------
if command -v amp >/dev/null 2>&1; then
  if amp mcp list 2>/dev/null | grep -q "sourcery"; then
    echo "amp: sourcery MCP server already configured"
  else
    amp mcp add sourcery -- npx -y "$NPM_SPEC" >/dev/null && echo "amp: added sourcery MCP server (global settings)"
  fi
  for skill in "$PLUGIN_ROOT"/skills/*/; do
    name="$(basename "$skill")"
    if ! amp skills list 2>/dev/null | grep -q "$name"; then
      amp skill add --global "${skill%/}" >/dev/null && echo "amp: installed skill $name"
    fi
  done
else
  echo "amp: not installed, skipping"
fi

# --- hermes ----------------------------------------------------------------
if command -v hermes >/dev/null 2>&1; then
  if hermes mcp list 2>/dev/null | grep -qi "sourcery"; then
    echo "hermes: sourcery MCP server already configured"
  else
    hermes mcp add sourcery --command npx --args -y "$NPM_SPEC" </dev/null >/dev/null && echo "hermes: added sourcery MCP server"
  fi
  link_skills "$HOME/.hermes/skills"
  echo "hermes: skills linked into ~/.hermes/skills/"
else
  echo "hermes: not installed, skipping"
fi

# --- openclaw ----------------------------------------------------------------
OPENCLAW=""
if [ -x "$HOME/.openclaw/bin/openclaw" ]; then
  OPENCLAW="$HOME/.openclaw/bin/openclaw"
elif command -v openclaw >/dev/null 2>&1; then
  OPENCLAW="$(command -v openclaw)"
fi
if [ -n "$OPENCLAW" ]; then
  if "$OPENCLAW" plugins list 2>/dev/null | grep -q "sourcery"; then
    echo "openclaw: sourcery-agent already installed"
  else
    "$OPENCLAW" plugins install --link "$PLUGIN_ROOT" >/dev/null && echo "openclaw: linked sourcery-agent bundle (restart the gateway to load)"
  fi
else
  echo "openclaw: not installed, skipping"
fi

# --- devin (skills; the CLI plugin route is documented, not automated) -------
DEVIN_LINKED=0
for d in "$HOME/.config/devin" "$HOME/.devin"; do
  if [ -d "$d" ]; then
    link_skills "$d/skills"
    echo "devin: skills linked in $d/skills"
    DEVIN_LINKED=1
  fi
done
if [ "$DEVIN_LINKED" -eq 0 ] && command -v devin >/dev/null 2>&1; then
  link_skills "$HOME/.config/devin/skills"
  echo "devin: skills linked in $HOME/.config/devin/skills"
  DEVIN_LINKED=1
fi
if [ "$DEVIN_LINKED" -eq 0 ]; then
  echo "devin: not detected, skipping"
fi
if command -v devin >/dev/null 2>&1; then
  echo "devin: for full plugin support run: devin plugins install --local \"$PLUGIN_ROOT\""
fi

# --- VS Code (chat.pluginLocations) ------------------------------------------
python3 - "$PLUGIN_ROOT" <<'PY'
import json
import os
import pathlib
import shutil
import sys
import time

repo = sys.argv[1]


def _vscode_settings():
    """Resolve the platform's VS Code user settings.json path, if it exists."""
    override = os.environ.get("VSCODE_USER_DIR")
    if override:
        candidates = [pathlib.Path(override)]
    elif sys.platform == "darwin":
        candidates = [pathlib.Path.home() / "Library/Application Support/Code/User"]
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        candidates = [pathlib.Path(appdata) / "Code/User"] if appdata else []
    elif sys.platform.startswith("linux"):
        candidates = [pathlib.Path.home() / ".config/Code/User"]
    else:
        candidates = []
    for directory in candidates:
        settings = directory / "settings.json"
        if settings.exists():
            return settings
    return None


settings = _vscode_settings()
if settings is None:
    print("vscode: settings.json not found (set VSCODE_USER_DIR to override), skipping")
    raise SystemExit(0)


def strip_jsonc(text: str) -> str:
    """Strip ``//`` and ``/* */`` comments and trailing commas from JSONC text."""
    out, i, n, in_str, esc = [], 0, len(text), False, False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            i += 1
        elif ch == '"':
            in_str = True
            out.append(ch)
            i += 1
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            if ch == ",":
                lookahead = i + 1
                while lookahead < n and text[lookahead] in " \t\r\n":
                    lookahead += 1
                if lookahead < n and text[lookahead] in "}]":
                    # Trailing comma outside any string: drop it.
                    i += 1
                    continue
            out.append(ch)
            i += 1
    return "".join(out)


try:
    data = json.loads(strip_jsonc(settings.read_text()))
except json.JSONDecodeError as exc:
    print(f"vscode: could not parse settings.json ({exc}); skipping")
    raise SystemExit(0)

locations = data.setdefault("chat.pluginLocations", {})
if locations.get(repo) is True:
    print("vscode: plugin location already enabled")
else:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = settings.with_name(f"settings.json.bak-agp-{stamp}")
    counter = 1
    while backup.exists():
        counter += 1
        backup = settings.with_name(f"settings.json.bak-agp-{stamp}-{counter}")
    shutil.copy2(settings, backup)
    locations[repo] = True
    if "chat.plugins.enabled" not in data:
        data["chat.plugins.enabled"] = True
    settings.write_text(json.dumps(data, indent=4) + "\n")
    print(f"vscode: enabled plugin at {repo} (backup: {backup.name})")
PY

echo "Done. Restart each host (or reload its window/session) to pick up the changes."
