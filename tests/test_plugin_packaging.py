"""Packaging tests: the repo must stay a valid hybrid plugin bundle.

Covers the Agent Plugins 1.0.0 core rules we rely on, plus the Claude Code
adapter, launcher executability, and the Codex marketplace entry.
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

AGP_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
AGP_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

# Closed top-level schema from the Agent Plugins 1.0.0 specification.
CORE_MANIFEST_FIELDS = {
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
}
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def test_core_manifest_follows_agent_plugins_rules():
    manifest = _load(REPO / "plugin.json")
    assert manifest["$schema"] == AGP_PLUGIN_SCHEMA
    assert set(manifest) <= CORE_MANIFEST_FIELDS
    name = manifest["name"]
    assert NAME_RE.match(name), name
    assert 1 <= len(name) <= 64
    assert "--" not in name and ".." not in name


def test_portable_mcp_config_is_valid_stdio():
    config = _load(REPO / "mcp.json")
    assert config["$schema"] == AGP_MCP_SCHEMA
    assert set(config) == {"$schema", "mcpServers"}
    server = config["mcpServers"]["sourcery"]
    assert server["type"] == "stdio"
    command = server["command"]
    # Spec: single executable token, plugin-relative with ./ prefix.
    assert command.startswith("./")
    assert " " not in command
    assert (REPO / command[2:]).is_file()


def test_claude_adapter_is_wired():
    manifest = _load(REPO / ".claude-plugin" / "plugin.json")
    assert manifest["name"] == "sourcery-agent"
    user_config = manifest["userConfig"]
    assert set(user_config) == {"sourcery_api_key"}
    assert user_config["sourcery_api_key"]["sensitive"] is True

    claude_mcp = _load(REPO / ".mcp.json")
    server = claude_mcp["mcpServers"]["sourcery"]
    assert server["command"] == "${CLAUDE_PLUGIN_ROOT}/bin/run-server"
    assert server["env"]["SOURCERY_API_KEY"] == "${user_config.sourcery_api_key}"


def test_skills_follow_agent_skills_layout():
    skill_files = sorted((REPO / "skills").glob("*/SKILL.md"))
    assert len(skill_files) >= 2
    for skill_md in skill_files:
        text = skill_md.read_text()
        assert text.startswith("---\n")
        front_matter = text.split("---", 2)[1]
        assert f"name: {skill_md.parent.name}" in front_matter
        assert "description:" in front_matter


def test_launchers_and_installer_are_executable():
    for relative in ("bin/_bootstrap", "bin/run-server", "bin/run-http", "scripts/install-rovodev.sh"):
        path = REPO / relative
        assert path.is_file(), relative
        assert path.stat().st_mode & 0o111, f"{relative} is not executable"


def test_codex_marketplace_entry_points_at_repo_root():
    marketplace = _load(REPO / ".agents" / "plugins" / "marketplace.json")
    assert marketplace["name"]
    entry = marketplace["plugins"][0]
    assert entry["source"]["source"] == "local"
    assert entry["source"]["path"].startswith("./")
    assert "policy" in entry
    assert "category" in entry


def test_local_hosts_installer_is_executable():
    path = REPO / "scripts" / "install-local-hosts.sh"
    assert path.is_file()
    assert path.stat().st_mode & 0o111, "install-local-hosts.sh is not executable"


def test_compatibility_docs_cover_all_hosts():
    text = (REPO / "docs" / "COMPATIBILITY.md").read_text()
    for host in (
        "Claude Code",
        "Cursor",
        "Codex",
        "ChatGPT",
        "VS Code",
        "Devin",
        "Grok",
        "Amp",
        "Hermes",
        "OpenClaw",
        "Rovo Dev",
    ):
        assert host in text, f"{host} missing from docs/COMPATIBILITY.md"


def test_cli_and_prewarm_launchers_are_executable():
    for relative in ("bin/sourcery-agent", "bin/prewarm"):
        path = REPO / relative
        assert path.is_file(), relative
        assert path.stat().st_mode & 0o111, f"{relative} is not executable"


def test_subagent_has_valid_frontmatter():
    text = (REPO / "agents" / "sourcery-triager.md").read_text()
    assert text.startswith("---\n")
    front_matter = text.split("---", 2)[1]
    assert "name: sourcery-triager" in front_matter
    assert "description:" in front_matter


def test_hooks_example_is_valid_json():
    data = _load(REPO / "examples" / "hooks" / "claude-hooks.json")
    assert "SessionStart" in data["hooks"]


def test_enabled_hooks_wire_to_prewarm():
    data = _load(REPO / "hooks" / "hooks.json")
    commands = [
        hook["command"]
        for entry in data["hooks"]["SessionStart"]
        for hook in entry["hooks"]
    ]
    assert any("bin/prewarm" in command for command in commands)


def test_shell_scripts_parse_cleanly():
    import subprocess

    scripts = [
        REPO / "bin" / name
        for name in ("_bootstrap", "run-server", "run-http", "sourcery-agent", "prewarm")
    ] + sorted((REPO / "scripts").glob("*.sh"))
    for script in scripts:
        result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        assert result.returncode == 0, f"{script.name}: {result.stderr}"


def test_rovodev_installer_refreshes_stale_skill_symlink(tmp_path):
    import os
    import subprocess

    home = tmp_path / "home"
    skills_dir = home / ".rovodev" / "skills"
    skills_dir.mkdir(parents=True)
    stale = skills_dir / "sourcery-triage"
    stale.symlink_to("/nonexistent/old/location/skills/sourcery-triage")

    result = subprocess.run(
        ["bash", str(REPO / "scripts" / "install-rovodev.sh")],
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    expected = REPO / "skills" / "sourcery-triage"
    assert stale.is_symlink()
    assert stale.resolve() == expected.resolve()

    manifest = skills_dir / ".sourcery-agent-managed"
    assert manifest.is_file()
    assert "sourcery-triage" in manifest.read_text()


def test_rovodev_installer_preserves_unmanaged_symlinks(tmp_path):
    import os
    import subprocess

    home = tmp_path / "home"
    skills_dir = home / ".rovodev" / "skills"
    skills_dir.mkdir(parents=True)
    custom = tmp_path / "my-custom-skill"
    custom.mkdir()
    link = skills_dir / "sourcery-triage"
    link.symlink_to(custom)

    result = subprocess.run(
        ["bash", str(REPO / "scripts" / "install-rovodev.sh")],
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert link.resolve() == custom.resolve()


def test_version_is_consistent_across_manifests():
    import tomllib

    versions = {
        tomllib.loads((REPO / "pyproject.toml").read_text())["project"]["version"],
        _load(REPO / "plugin.json")["version"],
        _load(REPO / ".claude-plugin" / "plugin.json")["version"],
    }
    assert len(versions) == 1, f"mismatched versions: {versions}"
