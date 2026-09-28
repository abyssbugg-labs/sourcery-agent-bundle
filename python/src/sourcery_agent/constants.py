"""Facts pinned from Sourcery's live OpenAPI document.

Everything here was verified against the snapshot committed at
``openapi/sourcery-openapi.json`` (fetched 2026-09-10):

    source   https://api.sourcery.ai/api/openapi.json
    info     Sourcery API 0.1.0 (OpenAPI 3.1.0)
    sha256   9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877

To refresh, re-download the spec (see ``openapi/README.md``) and update the
SHA-256 here at the same time.
"""

from __future__ import annotations

API_BASE = "https://api.sourcery.ai/api"
OPENAPI_URL = "https://api.sourcery.ai/api/openapi.json"
SPEC_INFO = "Sourcery API 0.1.0 (OpenAPI 3.1.0)"
SPEC_SNAPSHOT_PATH = "openapi/sourcery-openapi.json"
SPEC_SHA256 = "9fdb45e657a6406c86ea0d0def2963d534e20bec1a9c88f7d62dbc2e6807f877"
SPEC_FETCHED = "2026-09-10"

# Enum values from the spec.
ISSUE_TYPES = ("SAST", "IAC", "SECRET", "DEPENDENCY", "LICENSE")
STATUSES = ("ACTIVE", "IGNORED", "SNOOZED", "SOLVED")
# `SOLVED` is scanner-owned: issues become SOLVED automatically when a scan
# no longer detects them, so it is not accepted as PATCH input.
STATUS_INPUTS = ("ACTIVE", "IGNORED", "SNOOZED")
SEVERITIES = ("NO_RISK", "LOW", "MEDIUM", "HIGH", "CRITICAL")

BULK_UPDATE_MAX_IDS = 100
# Page-size cap for the list endpoints (the spec's `limit` maximum is 100).
LIST_MAX_LIMIT = 100

# The exact operations in the pinned document. `{id}` stands for an integer
# path parameter.
VERIFIED_OPERATIONS = (
    ("GET", "/api/v1/security-issues", "List security issues (filters + cursor pagination)"),
    ("GET", "/api/v1/security-issues/stats", "Aggregate issue counts by status and severity"),
    ("GET", "/api/v1/security-issues/{id}", "Fetch a single security issue"),
    ("PATCH", "/api/v1/security-issues", "Bulk-update issues (max 100 ids)"),
    ("GET", "/api/v1/security-issue-groups", "List security issue groups (filters + cursor pagination)"),
    ("GET", "/api/v1/security-issue-groups/stats", "Aggregate group counts by status and severity"),
    ("GET", "/api/v1/security-issue-groups/{id}", "Fetch a single issue group with its issues"),
    ("PATCH", "/api/v1/security-issue-groups", "Bulk-update groups (max 100 ids)"),
)

# Documented PR review controls — GitHub/GitLab comment or label commands,
# not public REST endpoints.
REVIEW_COMMANDS = ("review", "summary", "guide", "title", "resolve", "dismiss", "create issue")
