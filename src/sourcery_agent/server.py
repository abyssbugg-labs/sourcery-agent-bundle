"""MCPServer tools for Sourcery's public security API (mcp 2.x).

Wired against the pinned OpenAPI snapshot (``openapi/sourcery-openapi.json``);
``constants.VERIFIED_OPERATIONS`` lists the exact eight operations. Sourcery's
PR review commands (review, summary, guide, title, resolve, dismiss, create
issue) are GitHub/GitLab comment or label commands, not public REST — use your
Git provider connector for those.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from typing import Any

from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer

from . import constants
from .prompts import build_fix_prompt
from .sourcery_client import SourceryClient, validate_bulk_update

_INSTRUCTIONS = (
    "Sourcery security-findings triage and remediation. Start with "
    "sourcery_security_snapshot for an overview, drill into "
    "sourcery_list_findings / sourcery_get_finding, and use "
    "sourcery_build_fix_prompt to hand a finding to a coding agent. "
    "All tools are limited to Sourcery's public security API."
)


class StaticTokenVerifier:
    """Verify the single pre-shared bearer token from SOURCERY_MCP_AUTH_TOKEN."""

    def __init__(self, token: str) -> None:
        """Store the expected token as UTF-8 bytes for constant-time comparison."""
        self._token = token.encode("utf-8")

    async def verify_token(self, token: str) -> AccessToken | None:
        """Return access info for a matching token, else None."""
        token_bytes = token.encode("utf-8")
        if secrets.compare_digest(token_bytes, self._token):
            return AccessToken(token=token, client_id="sourcery-remote", scopes=["sourcery"])
        return None


def build_server(
    auth_token: str | None = None,
    resource_url: str | None = None,
) -> MCPServer:
    """Create the MCP server; a configured token enables SDK bearer verification."""
    kwargs: dict[str, Any] = {}
    token = (auth_token or "").strip()
    if token:
        resolved_resource_url = (
            resource_url
            or os.environ.get("SOURCERY_MCP_RESOURCE_URL")
            or "http://127.0.0.1:8765/mcp"
        )
        issuer_url = os.environ.get("SOURCERY_MCP_ISSUER_URL") or resolved_resource_url
        kwargs["token_verifier"] = StaticTokenVerifier(token)
        kwargs["auth"] = AuthSettings(
            issuer_url=issuer_url,
            resource_server_url=resolved_resource_url,
            validate_token_resource=False,
        )
    return MCPServer("Sourcery Agent Bundle", instructions=_INSTRUCTIONS, **kwargs)


mcp = build_server(os.environ.get("SOURCERY_MCP_AUTH_TOKEN"))


def _client() -> SourceryClient:
    """Build a client from the ambient configuration."""
    return SourceryClient()


def _check_subset(values: list[str] | None, allowed: tuple[str, ...], field: str) -> list[str] | None:
    """Validate that every value belongs to ``allowed``."""
    if values is None:
        return None
    bad = [value for value in values if value not in allowed]
    if bad:
        raise ValueError(f"{field} must be one of {allowed}; got {bad}")
    return list(values)


def _check_status(status: str | None) -> str | None:
    """Validate a caller-provided status against the PATCH inputs."""
    if status is not None and status not in constants.STATUS_INPUTS:
        raise ValueError(
            f"status must be one of {constants.STATUS_INPUTS} "
            "(SOLVED is scanner-owned and cannot be set manually)"
        )
    return status


def _check_severity(severity: str | None) -> str | None:
    """Validate a severity override against the known severities."""
    if severity is not None and severity not in constants.SEVERITIES:
        raise ValueError(f"severity_override must be one of {constants.SEVERITIES}")
    return severity


def _check_limit(limit: int) -> int:
    """Validate a page size against the API's 1..100 bound."""
    if not 1 <= limit <= constants.LIST_MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {constants.LIST_MAX_LIMIT}; got {limit}")
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
    status = _check_status(status)
    severity_override = _check_severity(severity_override)
    validate_bulk_update(status=status, snoozed_until=snoozed_until, severity_override=severity_override)
    return _client().bulk_update_issues(
        ids=ids,
        status=status,
        snoozed_until=snoozed_until,
        severity_override=severity_override,
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
    status = _check_status(status)
    severity_override = _check_severity(severity_override)
    validate_bulk_update(status=status, snoozed_until=snoozed_until, severity_override=severity_override)
    return _client().bulk_update_groups(
        ids=ids,
        status=status,
        snoozed_until=snoozed_until,
        severity_override=severity_override,
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

    normalized_method = method.upper()
    if normalized_method == "GET":
        if body is not None:
            raise ValueError(f"GET {path} does not accept a request body")
        _validate_get_params(path, params)
    elif normalized_method == "PATCH":
        if params:
            raise ValueError(f"PATCH {path} does not accept query parameters")
        if not isinstance(body, dict):
            raise ValueError("PATCH body must decode to an object")
        _validate_patch_body(path, body)
    else:
        raise ValueError("method must be GET or PATCH")

    return _client().request(
        method=normalized_method,
        path=path,
        params=params,
        json=body,
    )


_COLLECTION_PATHS = {
    "/api/v1/security-issues",
    "/api/v1/security-issue-groups",
}
_STATS_PATHS = {
    "/api/v1/security-issues/stats",
    "/api/v1/security-issue-groups/stats",
}
_ITEM_PATH = re.compile(
    r"^/api/v1/security-(?:issues|issue-groups)/[1-9][0-9]*$"
)


def _positive_integer_list(
    value: Any,
    field: str,
    *,
    max_items: int | None = None,
) -> list[int]:
    """Validate a JSON array of positive integer identifiers."""
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if max_items is not None and len(value) > max_items:
        raise ValueError(f"{field} must contain at most {max_items} entries")
    if any(type(item) is not int or item <= 0 for item in value):
        raise ValueError(f"{field} must contain only positive integers")
    return value


def _validate_get_params(path: str, params: dict[str, Any]) -> None:
    """Validate query parameters for one verified GET operation."""
    if path in _COLLECTION_PATHS:
        allowed = {"repository_ids", "issue_types", "statuses", "search", "limit", "cursor"}
    elif path in _STATS_PATHS:
        allowed = {"repository_ids", "issue_types"}
    elif _ITEM_PATH.fullmatch(path):
        allowed = set()
    else:
        raise ValueError(f"GET path is not a verified Sourcery operation: {path}")

    unknown = set(params) - allowed
    if unknown:
        raise ValueError(f"Unknown parameters for {path}: {sorted(unknown)}")
    if "repository_ids" in params:
        _positive_integer_list(params["repository_ids"], "repository_ids")
    if "issue_types" in params:
        issue_types = params["issue_types"]
        if not isinstance(issue_types, list):
            raise ValueError("issue_types must be an array")
        _check_subset(issue_types, constants.ISSUE_TYPES, "issue_types")
    if "statuses" in params:
        statuses = params["statuses"]
        if not isinstance(statuses, list):
            raise ValueError("statuses must be an array")
        _check_subset(statuses, constants.STATUSES, "statuses")
    if "limit" in params:
        if type(params["limit"]) is not int:
            raise ValueError("limit must be an integer")
        _check_limit(params["limit"])
    for field in ("search", "cursor"):
        if field in params and params[field] is not None and not isinstance(params[field], str):
            raise ValueError(f"{field} must be a string or null")


def _validate_patch_body(path: str, body: dict[str, Any]) -> None:
    """Validate a bulk update body for one verified PATCH operation."""
    if path not in _COLLECTION_PATHS:
        raise ValueError(f"PATCH path is not a verified Sourcery operation: {path}")
    allowed = {"ids", "status", "snoozed_until", "severity_override", "reason"}
    unknown = set(body) - allowed
    if unknown:
        raise ValueError(f"Unknown fields in PATCH {path}: {sorted(unknown)}")
    if "ids" not in body:
        raise ValueError(f"PATCH {path} requires 'ids' field")
    _positive_integer_list(
        body["ids"],
        "ids",
        max_items=constants.BULK_UPDATE_MAX_IDS,
    )

    status = body.get("status")
    severity = body.get("severity_override")
    _check_status(status)
    _check_severity(severity)
    for field in ("snoozed_until", "reason"):
        if field in body and body[field] is not None and not isinstance(body[field], str):
            raise ValueError(f"{field} must be a string or null")
    validate_bulk_update(
        status=status,
        snoozed_until=body.get("snoozed_until"),
        severity_override=severity,
    )


def main() -> None:
    """Run the MCP server over stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
