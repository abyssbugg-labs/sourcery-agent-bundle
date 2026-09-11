#!/usr/bin/env bash
# Register this plugin with the Rovo Dev CLI (acli rovodev):
#   * adds/updates the "sourcery" server in ~/.rovodev/mcp.json (timestamped backup kept)
#   * links the plugin's skills into ~/.rovodev/skills/
#
# Idempotent. Re-run it after moving/renaming this repository (the MCP entry
# bakes in an absolute path), or to refresh the wiring.
# Set SOURCERY_API_KEY in the environment Rovo Dev runs in (shell profile).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$PLUGIN_ROOT" <<'PY'
import json
import pathlib
import shutil
import sys
import time

plugin_root = pathlib.Path(sys.argv[1]).resolve()
home = pathlib.Path.home()

# --- MCP server entry -------------------------------------------------------
cfg_path = home / ".rovodev" / "mcp.json"
cfg = {}
if cfg_path.exists():
    cfg = json.loads(cfg_path.read_text())
    backup = cfg_path.with_name(f"mcp.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(cfg_path, backup)
    print(f"backup written: {backup}")

servers = cfg.setdefault("mcpServers", {})
servers["sourcery"] = {
    "type": "stdio",
    "command": str(plugin_root / "bin" / "run-server"),
}
cfg_path.parent.mkdir(parents=True, exist_ok=True)
cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"registered 'sourcery' server in {cfg_path}")

# --- skills -----------------------------------------------------------------
skills_dst = home / ".rovodev" / "skills"
skills_dst.mkdir(parents=True, exist_ok=True)
for skill in sorted((plugin_root / "skills").iterdir()):
    if not (skill / "SKILL.md").is_file():
        continue
    target = skills_dst / skill.name
    if target.exists() or target.is_symlink():
        print(f"skill {target.name}: already present, leaving as-is")
        continue
    target.symlink_to(skill)
    print(f"skill linked: {target}")
PY

echo "Done. Restart Rovo Dev (review the config with 'acli rovodev mcp') to pick up the changes."
