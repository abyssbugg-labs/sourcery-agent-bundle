"""Packaging tests: the repo must stay a valid hybrid plugin bundle.

Covers the Agent Plugins 1.0.0 core rules we rely on, plus the Claude Code
adapter, launcher executability, and the Codex marketplace entry.
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

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
    """Load a JSON file as a dictionary."""
    return json.loads(path.read_text())


def _parse_front_matter(text: str) -> dict:
    """Parse the leading YAML-style front matter block into a flat mapping."""
    assert text.startswith("---\n"), "front matter must open with ---"
    parts = text.split("---", 2)
    assert len(parts) == 3, "front matter must close with ---"
    fields = {}
    for line in parts[1].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition(":")
        if separator:
            fields[key.strip()] = value.strip()
    return fields


def test_core_manifest_follows_agent_plugins_rules():
    """plugin.json stays inside the closed Agent Plugins core schema."""
    manifest = _load(REPO / "plugin.json")
    assert manifest["$schema"] == AGP_PLUGIN_SCHEMA
    assert set(manifest) <= CORE_MANIFEST_FIELDS
    name = manifest["name"]
    assert NAME_RE.match(name), name
    assert 1 <= len(name) <= 64
    assert "--" not in name and ".." not in name


def test_portable_mcp_config_is_valid_stdio():
    """mcp.json declares a valid plugin-relative stdio server."""
    config = _load(REPO / "mcp.json")
    assert config["$schema"] == AGP_MCP_SCHEMA
    assert set(config) == {"$schema", "mcpServers"}
    server = config["mcpServers"]["sourcery"]
    assert server["type"] == "stdio"
    command = server["command"]
    # Spec: single executable token, plugin-relative with ./ prefix.
    assert command.startswith("./")
    assert " " not in command
    target = (REPO / command[2:]).resolve()
    assert target.is_file()
    assert target.is_relative_to(REPO.resolve()), "command escapes the plugin root"


def test_claude_adapter_is_wired():
    """Claude manifest and .mcp.json agree on the key wiring."""
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
    """Each skill folder has frontmatter whose name matches the folder."""
    skill_files = sorted((REPO / "skills").glob("*/SKILL.md"))
    assert len(skill_files) >= 2
    for skill_md in skill_files:
        fields = _parse_front_matter(skill_md.read_text())
        assert fields.get("name") == skill_md.parent.name
        description = fields.get("description")
        assert isinstance(description, str) and description.strip()


def test_launchers_and_installer_are_executable():
    """Launcher and installer scripts carry the executable bit."""
    for relative in ("bin/_bootstrap", "bin/run-server", "bin/run-http", "scripts/install-rovodev.sh"):
        path = REPO / relative
        assert path.is_file(), relative
        assert path.stat().st_mode & 0o111, f"{relative} is not executable"


def test_codex_marketplace_entry_points_at_repo_root():
    """The Codex marketplace entry points at the repo root with policy metadata."""
    marketplace = _load(REPO / ".agents" / "plugins" / "marketplace.json")
    assert marketplace["name"]
    entry = marketplace["plugins"][0]
    assert entry["source"]["source"] == "local"
    assert entry["source"]["path"].startswith("./")
    assert "policy" in entry
    assert "category" in entry


def test_local_hosts_installer_is_executable():
    """install-local-hosts.sh is present and executable."""
    path = REPO / "scripts" / "install-local-hosts.sh"
    assert path.is_file()
    assert path.stat().st_mode & 0o111, "install-local-hosts.sh is not executable"


def test_compatibility_docs_cover_all_hosts():
    """COMPATIBILITY.md mentions every supported host."""
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
    """The CLI and prewarm shims are present and executable."""
    for relative in ("bin/sourcery-agent", "bin/prewarm"):
        path = REPO / relative
        assert path.is_file(), relative
        assert path.stat().st_mode & 0o111, f"{relative} is not executable"


def test_subagent_has_valid_frontmatter():
    """The triager subagent declares name and description frontmatter."""
    fields = _parse_front_matter((REPO / "agents" / "sourcery-triager.md").read_text())
    assert fields.get("name") == "sourcery-triager"
    description = fields.get("description")
    assert isinstance(description, str) and description.strip()


def test_hooks_example_is_valid_json():
    """The hooks example parses and declares SessionStart."""
    data = _load(REPO / "examples" / "hooks" / "claude-hooks.json")
    assert "SessionStart" in data["hooks"]


def test_enabled_hooks_wire_to_prewarm():
    """The enabled hook invokes bin/prewarm on SessionStart."""
    data = _load(REPO / "hooks" / "hooks.json")
    commands = [
        hook["command"]
        for entry in data["hooks"]["SessionStart"]
        for hook in entry["hooks"]
    ]
    assert any("bin/prewarm" in command for command in commands)


def test_shell_scripts_parse_cleanly():
    """All shipped shell scripts pass ``bash -n``."""
    import subprocess

    scripts = [
        REPO / "bin" / name
        for name in ("_bootstrap", "run-server", "run-http", "sourcery-agent", "prewarm")
    ] + sorted((REPO / "scripts").glob("*.sh"))
    for script in scripts:
        result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        assert result.returncode == 0, f"{script.name}: {result.stderr}"


def test_rovodev_installer_refreshes_stale_skill_symlink(tmp_path):
    """A moved repository refreshes its recorded skill links."""
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
    """User-made skill symlinks are left untouched."""
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
    """pyproject and both plugin manifests declare a single version."""
    import tomllib

    versions = {
        tomllib.loads((REPO / "python" / "pyproject.toml").read_text())["project"]["version"],
        _load(REPO / "plugin.json")["version"],
        _load(REPO / ".claude-plugin" / "plugin.json")["version"],
    }
    assert len(versions) == 1, f"mismatched versions: {versions}"


def test_vscode_installer_preserves_quoted_brace_comma_values(tmp_path):
    """The JSONC cleaner keeps quoted values and strips only real trailing commas."""
    import os
    import subprocess

    settings_dir = tmp_path / "CodeUser"
    settings_dir.mkdir()
    (settings_dir / "settings.json").write_text('{\n  "note": ",}",\n  "keep": true,\n}\n')

    script = (REPO / "scripts" / "install-local-hosts.sh").read_text()
    block = script.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    result = subprocess.run(
        ["python3", "-c", block, str(REPO)],
        env={**os.environ, "VSCODE_USER_DIR": str(settings_dir)},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads((settings_dir / "settings.json").read_text())
    assert data["note"] == ",}"
    assert data["keep"] is True
    assert str(REPO) in data["chat.pluginLocations"]


def test_rovodev_installer_never_overwrites_an_existing_backup(tmp_path):
    """Same-stamp installs reserve a fresh backup path instead of clobbering."""
    import os
    import subprocess

    home = tmp_path / "home"
    rovodev = home / ".rovodev"
    rovodev.mkdir(parents=True)
    (rovodev / "mcp.json").write_text("{}\n")
    stamp = "20990101-000000"
    existing = rovodev / f"mcp.json.bak-{stamp}"
    existing.write_text("precious\n")

    result = subprocess.run(
        ["bash", str(REPO / "scripts" / "install-rovodev.sh")],
        env={**os.environ, "HOME": str(home), "SOURCERY_BACKUP_STAMP": stamp},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert existing.read_text() == "precious\n"
    assert (rovodev / f"mcp.json.bak-{stamp}-2").is_file()
