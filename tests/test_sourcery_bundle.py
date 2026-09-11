"""Tests for the allow-list gating and the finding → prompt builder."""

import pytest

from sourcery_agent import constants
from sourcery_agent.prompts import build_fix_prompt
from sourcery_agent.sourcery_client import SourceryClient, SourceryError, ensure_allowed


def _materialized_operations():
    return [(method, path.replace("{id}", "1")) for method, path, _ in constants.VERIFIED_OPERATIONS]


@pytest.mark.parametrize("method,path", _materialized_operations())
def test_all_verified_operations_are_allowed(method, path):
    ensure_allowed(method, path)


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/v1/security-issues/abc"),
        ("GET", "/api/v1/security-issues/1/extra"),
        ("GET", "/api/v1/security-issues/stats/extra"),
        ("PATCH", "/api/v1/security-issues/1"),
        ("DELETE", "/api/v1/security-issues"),
        ("POST", "/api/v1/security-issue-groups"),
        ("GET", "/api/v1/other"),
        ("GET", "/v1/security-issues"),
    ],
)
def test_unlisted_operations_are_rejected(method, path):
    with pytest.raises(SourceryError):
        ensure_allowed(method, path)


def test_client_requires_api_key(monkeypatch):
    monkeypatch.delenv("SOURCERY_API_KEY", raising=False)
    with pytest.raises(SourceryError):
        SourceryClient()


def test_client_rejects_unlisted_path_before_network(monkeypatch):
    monkeypatch.setenv("SOURCERY_API_KEY", "test-key")
    client = SourceryClient()
    with pytest.raises(SourceryError):
        client.request(method="GET", path="/api/v1/not-a-real-path")


def test_bulk_update_id_bounds_checked_before_network(monkeypatch):
    monkeypatch.setenv("SOURCERY_API_KEY", "test-key")
    client = SourceryClient()
    with pytest.raises(ValueError):
        client.bulk_update_issues(ids=[])
    with pytest.raises(ValueError):
        client.bulk_update_issues(ids=list(range(1, constants.BULK_UPDATE_MAX_IDS + 2)))


DEPENDENCY_FINDING = {
    "id": 42,
    "issue_group_id": 7,
    "repository_id": 1,
    "repository_name": "acme/api",
    "issue_type": "DEPENDENCY",
    "rule_id": "GHSA-xxxx-yyyy-zzzz",
    "documentation_url": "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
    "title": "Prototype pollution in lo-lib",
    "description": "lo-lib before 5.3.5 allows prototype pollution via merge.",
    "file_path": "package-lock.json",
    "line_start": 120,
    "line_end": 140,
    "commit_sha": "abc123",
    "source_code": None,
    "source_code_line_start": None,
    "package_name": "lo-lib",
    "package_version": "4.17.20",
    "package_type": "npm",
    "package_licenses": None,
    "fixed_versions": ["5.3.5", "4.5.4"],
    "manifest_file_path": "package.json",
    "dependency_graph": {
        "nodes": [
            {"name": "acme-api", "version": "1.0.0", "relationship": "root", "vulnerable": False, "dev": False},
            {"name": "lo-lib", "version": "4.17.20", "relationship": "indirect", "vulnerable": True, "dev": False},
        ],
        "edges": [{"from_package": "acme-api", "to_package": "lo-lib"}],
    },
    "severity": "HIGH",
    "status": "ACTIVE",
}

SAST_FINDING = {
    "id": 7,
    "issue_type": "SAST",
    "rule_id": "python.lang.security.audit.eval-detected",
    "title": "Unsafe use of eval",
    "description": "User input flows into eval().",
    "file_path": "src/app.py",
    "line_start": 10,
    "line_end": 12,
    "source_code": "result = eval(user_input)",
    "source_code_line_start": 10,
    "severity": "CRITICAL",
    "status": "ACTIVE",
}


def test_dependency_prompt_uses_manifest_fixed_versions_and_chain():
    prompt = build_fix_prompt(DEPENDENCY_FINDING)
    assert "Upgrade `lo-lib` from 4.17.20 to a fixed version (5.3.5, 4.5.4)" in prompt
    assert "Edit the manifest `package.json`" in prompt
    assert "acme-api@1.0.0 [root] -> lo-lib@4.17.20 [indirect]" in prompt
    assert "Keep the changes minimal" in prompt


def test_sast_prompt_includes_location_and_snippet():
    prompt = build_fix_prompt(SAST_FINDING)
    assert "src/app.py:10-12" in prompt
    assert "result = eval(user_input)" in prompt


def test_legacy_ui_keys_still_render():
    prompt = build_fix_prompt(
        {
            "title": "XSS in template",
            "risk": "Reflected XSS.",
            "cause": "Unescaped output.",
            "recommended_fix": "Escape the output.",
            "fix_impact": "Stops XSS.",
        }
    )
    assert "Reflected XSS." in prompt
    assert "Escape the output." in prompt
    assert "Stops XSS." in prompt
