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
import os
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
    stamp = os.environ.get("SOURCERY_BACKUP_STAMP") or time.strftime("%Y%m%d-%H%M%S")
    backup = cfg_path.with_name(f"mcp.json.bak-{stamp}")
    counter = 1
    while backup.exists():
        counter += 1
        backup = cfg_path.with_name(f"mcp.json.bak-{stamp}-{counter}")
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

managed_file = skills_dst / ".sourcery-agent-managed"
owned = set()
if managed_file.is_file():
    owned = {line.strip() for line in managed_file.read_text().splitlines() if line.strip()}
managed = set()


def is_proven_legacy_link(current, skill_name):
    """Recognize links created by this bundle before ownership manifests existed."""
    resolved = current.resolve(strict=False)
    if resolved.name != skill_name or resolved.parent.name != "skills":
        return False
    bundle_root = resolved.parent.parent
    manifest = bundle_root / "plugin.json"
    if not manifest.is_file() or not (resolved / "SKILL.md").is_file():
        return False
    try:
        metadata = json.loads(manifest.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return (
        isinstance(metadata, dict)
        and metadata.get("name") == "sourcery-agent-bundle"
    )


for skill in sorted((plugin_root / "skills").iterdir()):
    if not (skill / "SKILL.md").is_file():
        continue
    target = skills_dst / skill.name
    if target.is_symlink():
        raw_current = pathlib.Path(os.readlink(target))
        current = raw_current if raw_current.is_absolute() else target.parent / raw_current
        if current.resolve() == skill.resolve():
            managed.add(target.name)
            print(f"skill {target.name}: up to date")
            continue
        # Refresh links in the ownership manifest, plus identity-verified legacy links.
        if target.name in owned or is_proven_legacy_link(current, target.name):
            target.unlink()
            target.symlink_to(skill)
            managed.add(target.name)
            print(f"skill {target.name}: stale symlink refreshed -> {skill}")
            continue
        print(f"skill {target.name}: symlink not managed by this installer, leaving as-is")
        continue
    if target.exists():
        print(f"skill {target.name}: real directory present, leaving as-is")
        continue
    target.symlink_to(skill)
    managed.add(target.name)
    print(f"skill linked: {target}")

managed_file.write_text("\n".join(sorted(managed)) + "\n")
PY

echo "Done. Restart Rovo Dev (review the config with 'acli rovodev mcp') to pick up the changes."
