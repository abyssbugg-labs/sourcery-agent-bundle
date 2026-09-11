"""MCPServer tools for Sourcery's public security API (mcp 2.x).

Wired against the pinned OpenAPI snapshot (``openapi/sourcery-openapi.json``);
``constants.VERIFIED_OPERATIONS`` lists the exact eight operations. Sourcery's
PR review commands (review, summary, guide, title, resolve, dismiss, create
issue) are GitHub/GitLab comment or label commands, not public REST — use your
Git provider connector for those.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.mcpserver import MCPServer

from . import constants
from .prompts import build_fix_prompt
from .sourcery_client import SourceryClient

mcp = MCPServer(
    "Sourcery Agent Bundle",
    instructions=(
        "Sourcery security-findings triage and remediation. Start with "
        "sourcery_security_snapshot for an overview, drill into "
        "sourcery_list_findings / sourcery_get_finding, and use "
        "sourcery_build_fix_prompt to hand a finding to a coding agent. "
        "All tools are limited to Sourcery's public security API."
    ),
)


def _client() -> SourceryClient:
    return SourceryClient()


def _check_subset(values: list[str] | None, allowed: tuple[str, ...], field: str) -> list[str] | None:
    if values is None:
        return None
    bad = [value for value in values if value not in allowed]
    if bad:
        raise ValueError(f"{field} must be one of {allowed}; got {bad}")
    return list(values)


def _check_status(status: str | None) -> str | None:
    if status is not None and status not in constants.STATUS_INPUTS:
        raise ValueError(
            f"status must be one of {constants.STATUS_INPUTS} "
            "(SOLVED is scanner-owned and cannot be set manually)"
        )
    return status


def _check_severity(severity: str | None) -> str | None:
    if severity is not None and severity not in constants.SEVERITIES:
        raise ValueError(f"severity_override must be one of {constants.SEVERITIES}")
    return severity


def _check_limit(limit: int) -> int:
    if limit < 1:
        raise ValueError("limit must be >= 1")
    return limit


@mcp.tool()
def sourcery_capabilities() -> dict[str, Any]:
    """Return the verified Sourcery integration boundary for this bundle."""
    return {
        "public_api": "REST API for security findings (pinned OpenAPI snapshot)",
        "api_base": constants.API_BASE,
        "spec": {
            "url": constants.OPENAPI_URL,
            "info": constants.SPEC_INFO,
            "snapshot": constants.SPEC_SNAPSHOT_PATH,
            "sha256": constants.SPEC_SHA256,
            "fetched": constants.SPEC_FETCHED,
        },
        "operations": [
            {"method": method, "path": path, "description": description}
            for method, path, description in constants.VERIFIED_OPERATIONS
        ],
        "enums": {
            "issue_types": constants.ISSUE_TYPES,
            "statuses": constants.STATUSES,
            "status_inputs": constants.STATUS_INPUTS,
            "severities": constants.SEVERITIES,
        },
        "review_commands": {
            "commands": constants.REVIEW_COMMANDS,
            "transport": "GitHub/GitLab comments or labels, not public REST",
        },
    }


@mcp.tool()
def sourcery_security_snapshot(
    repository_ids: list[int] | None = None,
    issue_types: list[str] | None = None,
    limit: int = 25,
) -> dict[str, Any]:
    """Triage overview: counts by status/severity plus the first page of active issues."""
    issue_types = _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    client = _client()
    counts = client.issue_stats(repository_ids=repository_ids, issue_types=issue_types)
    active = client.list_issues(
        repository_ids=repository_ids,
        issue_types=issue_types,
        statuses=["ACTIVE"],
        limit=_check_limit(limit),
    )
    return {
        "counts": counts,
        "active_issues": active.get("data", []),
        "has_more": active.get("has_more"),
        "next_cursor": active.get("next_cursor"),
    }


@mcp.tool()
def sourcery_list_findings(
    repository_ids: list[int] | None = None,
    issue_types: list[str] | None = None,
    statuses: list[str] | None = None,
    search: str | None = None,
    limit: int = 20,
    cursor: str | None = None,
) -> Any:
    """List security issues with spec filters; pass a previous `next_cursor` to page."""
    issue_types = _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    statuses = _check_subset(statuses, constants.STATUSES, "statuses")
    return _client().list_issues(
        repository_ids=repository_ids,
        issue_types=issue_types,
        statuses=statuses,
        search=search,
        cursor=cursor,
        limit=_check_limit(limit),
    )


@mcp.tool()
def sourcery_get_finding(finding_id: int) -> Any:
    """Fetch a single security issue (full record incl. source snippet and dependency graph)."""
    return _client().get_issue(finding_id)


@mcp.tool()
def sourcery_get_security_counts(
    repository_ids: list[int] | None = None,
    issue_types: list[str] | None = None,
) -> Any:
    """Aggregate issue counts by status and severity."""
    issue_types = _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    return _client().issue_stats(repository_ids=repository_ids, issue_types=issue_types)


@mcp.tool()
def sourcery_bulk_update_findings(
    ids: list[int],
    status: str | None = None,
    snoozed_until: str | None = None,
    severity_override: str | None = None,
    reason: str | None = None,
) -> Any:
    """Bulk-update issue status/severity (max 100 ids; SOLVED cannot be set manually).

    Returns `updated_ids` plus `failed` entries with reason `not_found` or `not_eligible`.
    """
    return _client().bulk_update_issues(
        ids=ids,
        status=_check_status(status),
        snoozed_until=snoozed_until,
        severity_override=_check_severity(severity_override),
        reason=reason,
    )


@mcp.tool()
def sourcery_list_groups(
    repository_ids: list[int] | None = None,
    issue_types: list[str] | None = None,
    statuses: list[str] | None = None,
    search: str | None = None,
    limit: int = 20,
    cursor: str | None = None,
) -> Any:
    """List security issue groups (same filters as findings; groups aggregate one rule/package)."""
    issue_types = _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    statuses = _check_subset(statuses, constants.STATUSES, "statuses")
    return _client().list_groups(
        repository_ids=repository_ids,
        issue_types=issue_types,
        statuses=statuses,
        search=search,
        cursor=cursor,
        limit=_check_limit(limit),
    )


@mcp.tool()
def sourcery_get_group(group_id: int) -> Any:
    """Fetch a single issue group including all its issues and any linked tracker task."""
    return _client().get_group(group_id)


@mcp.tool()
def sourcery_get_group_counts(
    repository_ids: list[int] | None = None,
    issue_types: list[str] | None = None,
) -> Any:
    """Aggregate group counts by status and severity."""
    issue_types = _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    return _client().group_stats(repository_ids=repository_ids, issue_types=issue_types)


@mcp.tool()
def sourcery_bulk_update_groups(
    ids: list[int],
    status: str | None = None,
    snoozed_until: str | None = None,
    severity_override: str | None = None,
    reason: str | None = None,
) -> Any:
    """Bulk-update groups (max 100 ids); a group updates when at least one issue changes."""
    return _client().bulk_update_groups(
        ids=ids,
        status=_check_status(status),
        snoozed_until=snoozed_until,
        severity_override=_check_severity(severity_override),
        reason=reason,
    )


@mcp.tool()
def sourcery_build_fix_prompt(finding_json: str) -> str:
    """Build a minimal-change agent prompt from a Sourcery finding object.

    Handles DEPENDENCY findings via `fixed_versions` + `manifest_file_path` and
    renders the dependency chain when `dependency_graph` is present.
    """
    try:
        finding = json.loads(finding_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"finding_json is not valid JSON: {exc}") from exc
    if not isinstance(finding, dict):
        raise ValueError("finding_json must decode to an object")
    return build_fix_prompt(finding)


@mcp.tool()
def sourcery_api_request(
    method: str,
    path: str,
    params_json: str = "{}",
    body_json: str = "null",
) -> Any:
    """Compatibility bridge: call one of the eight verified operations directly.

    Prefer the typed tools. The path allow-list is enforced in the client; anything
    outside the pinned OpenAPI surface is rejected before a request is made.
    """
    try:
        params = json.loads(params_json) if params_json else {}
        body = json.loads(body_json) if body_json not in ("", "null", None) else None
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON argument: {exc}") from exc

    if not isinstance(params, dict):
        raise ValueError("params_json must decode to an object")

    return _client().request(method=method, path=path, params=params, json=body)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
