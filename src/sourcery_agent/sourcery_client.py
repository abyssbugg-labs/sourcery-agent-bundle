"""HTTP client for the pinned Sourcery security API surface.

Requests are gated against the exact operations in the OpenAPI snapshot
committed at ``openapi/sourcery-openapi.json`` (see ``constants``); anything
outside that surface is rejected before a socket is opened.

Paths use the ``/api/v1/...`` convention from the docs. ``SOURCERY_API_BASE``
already includes the ``/api`` prefix (default ``https://api.sourcery.ai/api``).
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

from .constants import API_BASE, BULK_UPDATE_MAX_IDS, LIST_MAX_LIMIT

_EXACT_OPERATIONS: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/v1/security-issues"),
        ("GET", "/api/v1/security-issues/stats"),
        ("PATCH", "/api/v1/security-issues"),
        ("GET", "/api/v1/security-issue-groups"),
        ("GET", "/api/v1/security-issue-groups/stats"),
        ("PATCH", "/api/v1/security-issue-groups"),
    }
)
_DETAIL_OPERATION = re.compile(r"^/api/v1/(?:security-issues|security-issue-groups)/\d+$")


class SourceryError(RuntimeError):
    """Report Sourcery API or configuration failures raised by this bundle."""

    pass


def ensure_allowed(method: str, path: str) -> None:
    """Raise unless ``method path`` is one of the eight verified operations."""
    method = method.upper()
    if (method, path) in _EXACT_OPERATIONS:
        return
    if method == "GET" and _DETAIL_OPERATION.match(path):
        return
    raise SourceryError(f"Operation is not in the pinned Sourcery OpenAPI surface: {method} {path}")


def _without_none(mapping: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so unset filters are omitted from requests."""
    return {key: value for key, value in mapping.items() if value is not None}


def _checked_ids(ids: list[int]) -> list[int]:
    """Validate bulk-update ids (non-empty, at most 100)."""
    if not ids:
        raise ValueError("ids must contain at least one id")
    if len(ids) > BULK_UPDATE_MAX_IDS:
        raise ValueError(f"ids must contain at most {BULK_UPDATE_MAX_IDS} ids; got {len(ids)}")
    return [int(value) for value in ids]


def _checked_limit(limit: int | None) -> int | None:
    """Validate a page size against the API's 1..100 bound."""
    if limit is None:
        return None
    if not 1 <= limit <= LIST_MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {LIST_MAX_LIMIT}; got {limit}")
    return limit


def validate_bulk_update(
    *,
    status: str | None,
    snoozed_until: str | None,
    severity_override: str | None,
) -> None:
    """Reject no-op updates and invalid snooze combinations."""
    if status is None and severity_override is None:
        raise ValueError(
            "bulk update requires status and/or severity_override; refusing to send a no-op PATCH"
        )
    if snoozed_until is not None and status != "SNOOZED":
        raise ValueError("snoozed_until is only valid with status='SNOOZED'")
    if status == "SNOOZED" and snoozed_until is None:
        raise ValueError("snoozed_until is required when status='SNOOZED'")


class SourceryClient:
    """Minimal client confined to the pinned Sourcery API operation surface."""

    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        """Resolve the API key and base URL (https only); raise without a key."""
        self.api_key = api_key or os.getenv("SOURCERY_API_KEY")
        if not self.api_key:
            raise SourceryError("SOURCERY_API_KEY is not configured")
        resolved_base = (base_url or os.getenv("SOURCERY_API_BASE") or API_BASE).rstrip("/")
        if not resolved_base.startswith("https://"):
            raise SourceryError(f"SOURCERY_API_BASE must be an https:// URL; got {resolved_base!r}")
        self.base_url = resolved_base

    def request(
        self,
        *,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> Any:
        """Perform one allow-listed API request and return the decoded JSON."""
        method = method.upper().strip()
        ensure_allowed(method, path)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        if json is not None:
            headers["Content-Type"] = "application/json"

        url = f"{self.base_url}{path.removeprefix('/api')}"
        try:
            with httpx.Client(timeout=20.0, follow_redirects=False) as client:
                response = client.request(
                    method=method,
                    url=url,
                    headers=headers,
                    params=params,
                    json=json,
                )
        except httpx.HTTPError as exc:
            raise SourceryError(f"Sourcery request failed: {exc}") from exc

        if response.status_code >= 400:
            body = response.text[:2000]
            raise SourceryError(f"Sourcery returned HTTP {response.status_code}: {body}")

        try:
            return response.json()
        except ValueError as exc:
            raise SourceryError(
                f"Sourcery returned a non-JSON response (HTTP {response.status_code}): {response.text[:200]}"
            ) from exc

    # -- security issues ---------------------------------------------------

    def list_issues(
        self,
        *,
        repository_ids: list[int] | None = None,
        issue_types: list[str] | None = None,
        statuses: list[str] | None = None,
        search: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> Any:
        """GET the security-issues page matching the given filters."""
        params = _without_none(
            {
                "repository_ids": repository_ids,
                "issue_types": issue_types,
                "statuses": statuses,
                "search": search,
                "cursor": cursor,
                "limit": _checked_limit(limit),
            }
        )
        return self.request(method="GET", path="/api/v1/security-issues", params=params)

    def get_issue(self, issue_id: int) -> Any:
        """GET one security issue by id."""
        return self.request(method="GET", path=f"/api/v1/security-issues/{int(issue_id)}")

    def issue_stats(
        self,
        *,
        repository_ids: list[int] | None = None,
        issue_types: list[str] | None = None,
    ) -> Any:
        """GET aggregate issue counts by status and severity."""
        params = _without_none({"repository_ids": repository_ids, "issue_types": issue_types})
        return self.request(method="GET", path="/api/v1/security-issues/stats", params=params)

    def bulk_update_issues(
        self,
        *,
        ids: list[int],
        status: str | None = None,
        snoozed_until: str | None = None,
        severity_override: str | None = None,
        reason: str | None = None,
    ) -> Any:
        """PATCH a status/severity change onto up to 100 issues."""
        validate_bulk_update(status=status, snoozed_until=snoozed_until, severity_override=severity_override)
        body = _without_none(
            {
                "ids": _checked_ids(ids),
                "status": status,
                "snoozed_until": snoozed_until,
                "severity_override": severity_override,
                "reason": reason,
            }
        )
        return self.request(method="PATCH", path="/api/v1/security-issues", json=body)

    # -- security issue groups ---------------------------------------------

    def list_groups(
        self,
        *,
        repository_ids: list[int] | None = None,
        issue_types: list[str] | None = None,
        statuses: list[str] | None = None,
        search: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> Any:
        """GET the security-issue-groups page matching the given filters."""
        params = _without_none(
            {
                "repository_ids": repository_ids,
                "issue_types": issue_types,
                "statuses": statuses,
                "search": search,
                "cursor": cursor,
                "limit": _checked_limit(limit),
            }
        )
        return self.request(method="GET", path="/api/v1/security-issue-groups", params=params)

    def get_group(self, group_id: int) -> Any:
        """GET one issue group (with its issues) by id."""
        return self.request(method="GET", path=f"/api/v1/security-issue-groups/{int(group_id)}")

    def group_stats(
        self,
        *,
        repository_ids: list[int] | None = None,
        issue_types: list[str] | None = None,
    ) -> Any:
        """GET aggregate group counts by status and severity."""
        params = _without_none({"repository_ids": repository_ids, "issue_types": issue_types})
        return self.request(method="GET", path="/api/v1/security-issue-groups/stats", params=params)

    def bulk_update_groups(
        self,
        *,
        ids: list[int],
        status: str | None = None,
        snoozed_until: str | None = None,
        severity_override: str | None = None,
        reason: str | None = None,
    ) -> Any:
        """PATCH a status/severity change onto up to 100 groups."""
        validate_bulk_update(status=status, snoozed_until=snoozed_until, severity_override=severity_override)
        body = _without_none(
            {
                "ids": _checked_ids(ids),
                "status": status,
                "snoozed_until": snoozed_until,
                "severity_override": severity_override,
                "reason": reason,
            }
        )
        return self.request(method="PATCH", path="/api/v1/security-issue-groups", json=body)
