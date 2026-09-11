"""Tests for the user-facing CLI surface (argument wiring + formatting)."""

from sourcery_agent import cli


def test_parser_has_expected_commands():
    parser = cli.build_parser()
    for argv in (["snapshot"], ["list"], ["get", "1"], ["counts"], ["fix-prompt", "2"]):
        args = parser.parse_args(argv)
        assert callable(args.func)


def test_row_formatting_handles_spec_finding():
    row = cli.format_finding_row(
        {
            "id": 7,
            "severity": "HIGH",
            "issue_type": "SAST",
            "status": "ACTIVE",
            "title": "Unsafe use of eval",
            "file_path": "src/app.py",
        }
    )
    assert "7" in row
    assert "HIGH" in row
    assert "src/app.py" in row


def test_row_formatting_falls_back_to_package_location():
    row = cli.format_finding_row(
        {
            "id": 42,
            "severity": "CRITICAL",
            "issue_type": "DEPENDENCY",
            "status": "ACTIVE",
            "title": "Prototype pollution",
            "package_name": "lo-lib",
            "package_version": "4.17.20",
        }
    )
    assert "lo-lib@4.17.20" in row


def test_usable_key_rejects_placeholders():
    assert cli.usable_key("real-key") is True
    assert cli.usable_key("${user_config.sourcery_api_key}") is False
    assert cli.usable_key("") is False
    assert cli.usable_key(None) is False


def test_main_reports_missing_key(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SOURCERY_API_KEY", raising=False)
    monkeypatch.delenv("PLUGIN_DATA", raising=False)
    monkeypatch.delenv("CLAUDE_PLUGIN_DATA", raising=False)
    monkeypatch.setenv("SOURCERY_API_KEY_FILE", str(tmp_path / "definitely-missing-key"))
    assert cli.main(["snapshot"]) == 1
    assert "SOURCERY_API_KEY" in capsys.readouterr().err


def test_main_reports_key_file_read_errors(tmp_path, monkeypatch, capsys):
    key_file = tmp_path / "unreadable-key"
    key_file.write_text("not-used")
    key_file.chmod(0)
    monkeypatch.delenv("SOURCERY_API_KEY", raising=False)
    monkeypatch.setenv("SOURCERY_API_KEY_FILE", str(key_file))
    assert cli.main(["snapshot"]) == 1
    assert "sourcery-agent:" in capsys.readouterr().err
